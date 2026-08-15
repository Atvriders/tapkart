// ADAPTER (§8.2). The ONLY module in the repository that imports `three`, and the
// only thing that touches a Three.js scene graph (§7.2). CI never imports this
// file: src/index.ts deliberately does not re-export it, so a headless vitest run
// never pulls three -- or, transitively, a WebGL context -- into the process.
//
// Everything here is owner-verified, not CI-verified (§8.3): CI proves the
// RenderFrame is right and that this adapter was handed it. It cannot prove
// Three.js drew it, that the shader compiled, or that the kart is not inside the
// road.
import {
  AmbientLight,
  BoxGeometry,
  BufferAttribute,
  BufferGeometry,
  Color,
  DirectionalLight,
  Euler,
  Fog,
  Group,
  InstancedMesh,
  LinearSRGBColorSpace,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  MeshLambertMaterial,
  OrthographicCamera,
  PerspectiveCamera,
  PlaneGeometry,
  Quaternion,
  SRGBColorSpace,
  Scene,
  SphereGeometry,
  Vector3,
  WebGLRenderer,
} from 'three'

import { MAX_ENTITIES, MAX_KARTS } from '@tapkart/sim'
import type { Vec3 } from '@tapkart/sim'
import type { PaletteRGB, TrackTheme } from '@tapkart/content'

import type { RendererBackend, RendererStats } from '../backend'
import type { KartDraw, RenderFrame } from '../frame'
import { ROAD_DECAL_LIFT, meshCounts } from '../mesh'
import type { EdgeMarkerPlacement, MarkerPlacement, MeshData, TrackScene } from '../mesh'

export interface ThreeRendererOptions {
  antialias: boolean
  maxPixelRatio: number       // 2 by default; phones lie about theirs
  shadows: boolean            // false in v1
}

export const DEFAULT_THREE_OPTIONS: Readonly<ThreeRendererOptions> = Object.freeze({
  antialias: true,
  maxPixelRatio: 2,
  shadows: false,
})

const SHIELD_SCALE = 1.6
const ENTITY_SPHERE_SEGMENTS = 10
const MARKER_POST_THICKNESS = 0.18
const ITEM_BOX_SIZE = 1.4
const ITEM_BOX_COLOR = 0xffd24a
/** The ground quad is `scene.bounds` widened by this factor, so the plane reaches
 *  past the ribbon to the fog rather than ending in mid-air at the road's edge. */
const GROUND_MARGIN = 3
/** …and sits this far under the lowest road vertex, so it never z-fights the ribbon. */
const GROUND_DROP = 0.05
const CHECKPOINT_BAR_LENGTH = 0.6
const CHECKPOINT_BAR_HEIGHT = 0.04

function setColor(target: Color, rgb: PaletteRGB): void {
  target.setRGB(rgb[0], rgb[1], rgb[2], LinearSRGBColorSpace)
}

function toGeometry(data: MeshData): BufferGeometry {
  const geo = new BufferGeometry()
  geo.setAttribute('position', new BufferAttribute(data.positions, 3))
  if (data.normals.length > 0) geo.setAttribute('normal', new BufferAttribute(data.normals, 3))
  if (data.uvs.length > 0) geo.setAttribute('uv', new BufferAttribute(data.uvs, 2))
  if (data.colors.length > 0) geo.setAttribute('color', new BufferAttribute(data.colors, 3))
  geo.setIndex(new BufferAttribute(data.indices, 1))
  geo.computeBoundingSphere()
  return geo
}

export function createThreeRenderer(
  canvas: HTMLCanvasElement,
  opts: ThreeRendererOptions,
): RendererBackend {
  const renderer = new WebGLRenderer({ canvas, antialias: opts.antialias })
  renderer.outputColorSpace = SRGBColorSpace
  renderer.shadowMap.enabled = opts.shadows
  renderer.autoClear = false

  const scene = new Scene()
  const camera = new PerspectiveCamera(62, 1, 0.3, 900)
  const ambient = new AmbientLight(0xffffff, 0.6)
  const sun = new DirectionalLight(0xffffff, 1.1)
  scene.add(ambient)
  scene.add(sun)

  const staticRoot = new Group()
  scene.add(staticRoot)

  // The ground plane. §12 fixes the whole visual budget as "a ribbon over a themed
  // ground plane plus procedural edge markers", and Q19 makes `TrackScene.bounds` a
  // render extent for exactly this — ground-plane size, camera far clamp, skybox
  // scale. Without it the ribbon floats over the sky's bottom colour, Q20's speed cue
  // is half-delivered, and six themes are gated on a `theme.ground` nothing draws.
  // One quad, allocated once, resized and recoloured per track in setScene.
  const groundGeometry = new PlaneGeometry(1, 1)
  const groundMaterial = new MeshLambertMaterial()
  const ground = new Mesh(groundGeometry, groundMaterial)
  ground.rotation.x = -Math.PI / 2   // PlaneGeometry is XY; local +y becomes world +z
  scene.add(ground)

  // The screen tint (surge) and flash (charge) are a second, orthographic pass
  // rather than a post-processing chain: two quads cost one draw call each and no
  // render target on a phone.
  const overlayScene = new Scene()
  const overlayCamera = new OrthographicCamera(-1, 1, 1, -1, 0, 1)
  const overlayGeometry = new PlaneGeometry(2, 2)
  const tintMaterial = new MeshBasicMaterial({
    transparent: true, depthTest: false, depthWrite: false, opacity: 0,
  })
  const flashMaterial = new MeshBasicMaterial({
    color: 0xffffff, transparent: true, depthTest: false, depthWrite: false, opacity: 0,
  })
  const tintQuad = new Mesh(overlayGeometry, tintMaterial)
  const flashQuad = new Mesh(overlayGeometry, flashMaterial)
  tintQuad.visible = false
  flashQuad.visible = false
  overlayScene.add(tintQuad)
  overlayScene.add(flashQuad)

  // Per-seat scene graph, allocated once (§7.3): the outer group carries position
  // and yaw, the inner group carries roll about the kart's own forward axis.
  const kartGeometries: BufferGeometry[] = []
  const characterGeometries: BufferGeometry[] = []
  const kartRoots: Group[] = []
  const kartTilts: Group[] = []
  const kartBodies: Mesh<BufferGeometry, MeshLambertMaterial>[] = []
  const kartHeads: Mesh<BufferGeometry, MeshLambertMaterial>[] = []
  const kartShields: Mesh<BufferGeometry, MeshBasicMaterial>[] = []
  const entityMeshes: Mesh<BufferGeometry, MeshLambertMaterial>[] = []

  const shieldGeometry = new SphereGeometry(1, 12, 8)
  const entityGeometry = new SphereGeometry(0.5, ENTITY_SPHERE_SEGMENTS, ENTITY_SPHERE_SEGMENTS)

  // Item boxes. `TrackScene.itemBoxes[i]` and `RenderFrame.itemBoxAlpha[i]` are the
  // same box (§4.3), so this array is index-paired with both. Q29's ghosting is
  // per-box opacity and a per-instance opacity needs a custom shader, so each box is
  // its own Mesh over one shared geometry — 16 to 24 per shipped track, which is the
  // entire cost of the pickup the item system is built on being visible.
  const itemBoxGeometry = new BoxGeometry(ITEM_BOX_SIZE, ITEM_BOX_SIZE, ITEM_BOX_SIZE)
  const itemBoxMeshes: Mesh<BufferGeometry, MeshBasicMaterial>[] = []

  for (let i = 0; i < MAX_KARTS; i++) {
    const root = new Group()
    const tilt = new Group()
    const body = new Mesh(new BufferGeometry(), new MeshLambertMaterial({ transparent: true }))
    const head = new Mesh(new BufferGeometry(), new MeshLambertMaterial({ transparent: true }))
    const shield = new Mesh(shieldGeometry, new MeshBasicMaterial({
      color: 0x66ccff, transparent: true, opacity: 0.25, depthWrite: false,
    }))
    shield.scale.setScalar(SHIELD_SCALE)
    shield.visible = false
    tilt.add(body)
    tilt.add(head)
    tilt.add(shield)
    root.add(tilt)
    root.visible = false
    scene.add(root)
    kartRoots.push(root)
    kartTilts.push(tilt)
    kartBodies.push(body)
    kartHeads.push(head)
    kartShields.push(shield)
  }

  for (let i = 0; i < MAX_ENTITIES; i++) {
    const mesh = new Mesh(entityGeometry, new MeshLambertMaterial({ transparent: true }))
    mesh.visible = false
    scene.add(mesh)
    entityMeshes.push(mesh)
  }

  const ownedGeometries: BufferGeometry[] = [
    shieldGeometry, entityGeometry, overlayGeometry, groundGeometry, itemBoxGeometry,
  ]
  const ownedMaterials: (MeshBasicMaterial | MeshLambertMaterial)[] = [
    tintMaterial, flashMaterial, groundMaterial,
  ]
  for (const m of kartBodies) ownedMaterials.push(m.material)
  for (const m of kartHeads) ownedMaterials.push(m.material)
  for (const m of kartShields) ownedMaterials.push(m.material)
  for (const m of entityMeshes) ownedMaterials.push(m.material)

  const scratchColor = new Color()
  const scratchVector = new Vector3()
  const scratchQuat = new Quaternion()
  const scratchEuler = new Euler(0, 0, 0, 'YXZ')
  const scratchScale = new Vector3(1, 1, 1)
  const scratchMatrix = new Matrix4()

  const ownedStaticGeometries: BufferGeometry[] = []
  const ownedStaticMaterials: (MeshBasicMaterial | MeshLambertMaterial)[] = []

  let sceneVertices = 0
  let sceneTriangles = 0
  let disposed = false

  function clearStatic(): void {
    for (const child of staticRoot.children.slice()) staticRoot.remove(child)
    for (const geo of ownedStaticGeometries) geo.dispose()
    for (const mat of ownedStaticMaterials) mat.dispose()
    ownedStaticGeometries.length = 0
    ownedStaticMaterials.length = 0
    itemBoxMeshes.length = 0      // their materials are in ownedStaticMaterials
  }

  /**
   * No colour argument, and that is the point. `buildTrackScene` bakes the theme into
   * every surface's vertex colours — road, dirt, shoulder, wall, boost pads and ramps
   * — and §7.2 makes it the sole writer of track colour. A material colour here would
   * be a second palette: `vertexColors: true` MULTIPLIES `material.color` by the
   * vertex colour, so setting both ships the road at `theme.road` squared, which turns
   * a 0.18 grey into a near-black 0.032. White is the multiplicative identity. It also
   * means a surface added later cannot be forgotten by the colouring pass, because
   * there is only one.
   */
  function addSurface(data: MeshData): void {
    if (data.indices.length === 0) return      // `neon-district` has no ramps (§4.3)
    const geo = toGeometry(data)
    const mat = new MeshLambertMaterial({ vertexColors: data.colors.length > 0 })
    // left at its default 0xffffff; §0a forbids this file from making colour decisions
    ownedStaticGeometries.push(geo)
    ownedStaticMaterials.push(mat)
    staticRoot.add(new Mesh(geo, mat))
  }

  /** One Mesh per box, materials owned by `ownedStaticMaterials` so `clearStatic`
   *  disposes them with the rest of the track. Positions are static track furniture;
   *  only opacity moves, and it moves in `applyFrame`. */
  function addItemBoxes(positions: readonly Vec3[]): void {
    for (const p of positions) {
      const mat = new MeshBasicMaterial({ color: ITEM_BOX_COLOR, transparent: true, opacity: 1 })
      const box = new Mesh(itemBoxGeometry, mat)
      box.position.set(p.x, p.y + ITEM_BOX_SIZE / 2, p.z)
      ownedStaticMaterials.push(mat)
      staticRoot.add(box)
      itemBoxMeshes.push(box)
    }
  }

  function addEdgeMarkers(posts: readonly EdgeMarkerPlacement[], theme: TrackTheme): void {
    const height = theme.edgeMarkers.height
    const geo = new BoxGeometry(MARKER_POST_THICKNESS, height, MARKER_POST_THICKNESS)
    ownedStaticGeometries.push(geo)
    for (const colorIdx of [0, 1] as const) {
      const of = posts.filter((p) => p.colorIdx === colorIdx)
      if (of.length === 0) continue
      const mat = new MeshLambertMaterial()
      setColor(mat.color, theme.edgeMarkers.colors[colorIdx])
      ownedStaticMaterials.push(mat)
      // One InstancedMesh per colour: hundreds of posts, two draw calls.
      const inst = new InstancedMesh(geo, mat, of.length)
      for (let i = 0; i < of.length; i++) {
        const p = of[i]
        scratchVector.set(p.position.x, p.position.y + height / 2, p.position.z)
        scratchEuler.set(0, -p.heading, 0)
        scratchQuat.setFromEuler(scratchEuler)
        scratchScale.set(1, 1, 1)
        scratchMatrix.compose(scratchVector, scratchQuat, scratchScale)
        inst.setMatrixAt(i, scratchMatrix)
      }
      inst.instanceMatrix.needsUpdate = true
      staticRoot.add(inst)
    }
  }

  function addCheckpoints(marks: readonly MarkerPlacement[], theme: TrackTheme): void {
    if (marks.length === 0) return
    const geo = new BoxGeometry(CHECKPOINT_BAR_LENGTH, CHECKPOINT_BAR_HEIGHT, 1)
    const mat = new MeshLambertMaterial()
    setColor(mat.color, theme.wall)
    ownedStaticGeometries.push(geo)
    ownedStaticMaterials.push(mat)
    const inst = new InstancedMesh(geo, mat, marks.length)
    for (let i = 0; i < marks.length; i++) {
      const m = marks[i]
      scratchVector.set(m.position.x, m.position.y + ROAD_DECAL_LIFT, m.position.z)
      scratchEuler.set(0, -m.heading, 0)
      scratchQuat.setFromEuler(scratchEuler)
      scratchScale.set(1, 1, m.width)
      scratchMatrix.compose(scratchVector, scratchQuat, scratchScale)
      inst.setMatrixAt(i, scratchMatrix)
    }
    inst.instanceMatrix.needsUpdate = true
    staticRoot.add(inst)
  }

  function applyKart(i: number, k: KartDraw): void {
    const root = kartRoots[i]
    root.visible = k.visible
    if (!k.visible) return
    const body = kartBodies[i]
    const head = kartHeads[i]
    const tilt = kartTilts[i]
    const shield = kartShields[i]

    const kartGeo = kartGeometries[k.characterIdx]
    const charGeo = characterGeometries[k.characterIdx]
    if (kartGeo !== undefined && body.geometry !== kartGeo) body.geometry = kartGeo
    if (charGeo !== undefined && head.geometry !== charGeo) head.geometry = charGeo

    // `heading` is a world yaw whose forward is (cos h, 0, sin h) -- the
    // convention §4.7's bubblePosition is written in -- and a Three yaw turns +x
    // toward -z, so the scene-graph rotation is -heading. Descriptor meshes are
    // authored +x forward, +y up.
    root.position.set(k.position.x, k.position.y, k.position.z)
    root.rotation.set(0, -k.heading, 0)
    tilt.rotation.set(k.roll, 0, 0)

    setColor(body.material.color, k.bodyTint)
    body.material.opacity = k.alpha
    head.material.opacity = k.alpha
    body.material.emissive.setRGB(k.boostFlame * 0.9, k.boostFlame * 0.35, 0, LinearSRGBColorSpace)
    shield.visible = k.shieldVisible
  }

  return {
    setScene(trackScene: TrackScene, theme: TrackTheme,
             kartMeshes: readonly MeshData[], characterMeshes: readonly MeshData[]): void {
      clearStatic()
      addSurface(trackScene.road)
      addSurface(trackScene.boostPads)
      addSurface(trackScene.ramps)
      addEdgeMarkers(trackScene.edgeMarkers, theme)
      addCheckpoints(trackScene.checkpoints, theme)
      addItemBoxes(trackScene.itemBoxes)

      // The ground plane, sized from the render extent Q19 computes `bounds` for and
      // coloured `theme.ground` — the one field of the theme that six themes are gated
      // on and that nothing else in this package draws (§12).
      const spanX = trackScene.bounds.max.x - trackScene.bounds.min.x
      const spanZ = trackScene.bounds.max.z - trackScene.bounds.min.z
      ground.scale.set(spanX * GROUND_MARGIN, spanZ * GROUND_MARGIN, 1)
      ground.position.set(
        (trackScene.bounds.min.x + trackScene.bounds.max.x) / 2,
        trackScene.bounds.min.y - GROUND_DROP,
        (trackScene.bounds.min.z + trackScene.bounds.max.z) / 2,
      )
      setColor(groundMaterial.color, theme.ground)

      for (const geo of kartGeometries) geo.dispose()
      for (const geo of characterGeometries) geo.dispose()
      kartGeometries.length = 0
      characterGeometries.length = 0
      for (const data of kartMeshes) kartGeometries.push(toGeometry(data))
      for (const data of characterMeshes) characterGeometries.push(toGeometry(data))

      setColor(scratchColor, theme.sky.bottom)
      scene.background = new Color(scratchColor)
      setColor(scratchColor, theme.fog.color)
      scene.fog = new Fog(scratchColor.getHex(), theme.fog.near, theme.fog.far)
      ambient.intensity = theme.ambient
      sun.position.set(theme.sunDirection.x, theme.sunDirection.y, theme.sunDirection.z)
      sun.position.multiplyScalar(100)

      const counts = meshCounts([
        trackScene.road, trackScene.boostPads, trackScene.ramps,
        ...kartMeshes, ...characterMeshes,
      ])
      sceneVertices = counts.vertices
      sceneTriangles = counts.triangles
    },

    applyFrame(frame: RenderFrame): void {
      camera.position.set(frame.camera.position.x, frame.camera.position.y, frame.camera.position.z)
      camera.up.set(frame.camera.up.x, frame.camera.up.y, frame.camera.up.z)
      scratchVector.set(frame.camera.lookAt.x, frame.camera.lookAt.y, frame.camera.lookAt.z)
      camera.lookAt(scratchVector)
      if (camera.fov !== frame.camera.fovDegrees) {
        camera.fov = frame.camera.fovDegrees
        camera.updateProjectionMatrix()
      }

      for (let i = 0; i < MAX_KARTS; i++) applyKart(i, frame.karts[i])

      for (let i = 0; i < MAX_ENTITIES; i++) {
        const mesh = entityMeshes[i]
        const e = frame.entities[i]
        if (!e.visible) {
          mesh.visible = false      // includes every 'surge', which is never drawn (Q27)
          continue
        }
        mesh.visible = true
        mesh.position.set(e.position.x, e.position.y, e.position.z)
        mesh.rotation.set(0, -e.heading, 0)
        mesh.scale.setScalar(e.scale)
        setColor(mesh.material.color, e.tint)
        mesh.material.opacity = e.alpha
      }

      // Index i is box i in TrackScene.itemBoxes: the same pairing §4.3 pins and the
      // mesh task asserts against sim's own itemBoxWorldPos. Alpha 0 is a taken box
      // mid-respawn (Q29), and `visible = false` skips the draw call entirely.
      for (let i = 0; i < itemBoxMeshes.length; i++) {
        const alpha = frame.itemBoxAlpha[i]
        const box = itemBoxMeshes[i]
        box.visible = alpha > 0
        box.material.opacity = alpha
      }

      tintQuad.visible = frame.screenTintAmount > 0
      if (tintQuad.visible) {
        setColor(tintMaterial.color, frame.screenTintColor)
        tintMaterial.opacity = frame.screenTintAmount
      }
      flashQuad.visible = frame.screenFlash > 0
      if (flashQuad.visible) flashMaterial.opacity = frame.screenFlash

      renderer.clear()
      renderer.render(scene, camera)
      renderer.render(overlayScene, overlayCamera)
    },

    resize(widthPx: number, heightPx: number, devicePixelRatio: number): void {
      const w = Math.max(1, widthPx)
      const h = Math.max(1, heightPx)
      renderer.setPixelRatio(Math.min(devicePixelRatio, opts.maxPixelRatio))
      renderer.setSize(w, h, false)     // the shell owns CSS sizing, not the renderer
      camera.aspect = w / h
      camera.updateProjectionMatrix()
    },

    stats(): RendererStats {
      return {
        drawCalls: renderer.info.render.calls,
        vertices: sceneVertices,
        triangles: sceneTriangles,
      }
    },

    dispose(): void {
      if (disposed) return
      disposed = true
      clearStatic()
      for (const geo of kartGeometries) geo.dispose()
      for (const geo of characterGeometries) geo.dispose()
      kartGeometries.length = 0
      characterGeometries.length = 0
      for (const geo of ownedGeometries) geo.dispose()
      for (const mat of ownedMaterials) mat.dispose()
      renderer.dispose()
    },
  }
}

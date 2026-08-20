# Server environment

Every variable `@tapkart/server` recognises is declared in `ENV_SCHEMA` in
`packages/server/src/env.ts`. The container files and this table are asserted
against that source, so configuration drift is a build failure.

- Unknown variables are ignored, except an unknown name beginning `TAPKART_`,
  which throws because that namespace belongs to this application.
- An unset variable takes its default. An empty value does not:
  `ICE_SERVERS=` means no ICE servers.

| Variable | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `PORT` | number | no | `3037` | The port the HTTP and WebSocket server binds. Spec §9. |
| `BIND_HOST` | string | no | `0.0.0.0` | The address to bind. A wildcard, never a real hostname. |
| `STATIC_ROOT` | string | no | `apps/web/dist` | The web build to serve, relative to the working directory. `<STATIC_ROOT>/.well-known/` is the one well-known directory. |
| `MAX_ROOMS` | number | no | `64` | Rooms per process. At the cap a create is refused rather than a live race evicted. |
| `MAX_PEERS_PER_ROOM` | number | no | `8` | Peers per room. The ninth joiner is refused with `roomFull`; there are no spectators. |
| `ROOM_IDLE_MS` | number | no | `600000` | How long a room may sit idle before it is closed. |
| `JOIN_RATE_WINDOW_MS` | number | no | `60000` | The failed-join window, counted per ROOM CODE and never per IP. |
| `JOIN_RATE_MAX` | number | no | `10` | Failed joins allowed per room code per window. A successful join costs nothing. |
| `ICE_SERVERS` | csv | no | `stun:stun.l.google.com:19302` | Comma-separated ICE URLs. The default is a third-party endpoint contacted at connection time; set it empty to use none. |
| `SHADOW_ENABLED` | boolean | no | `true` | Compatibility guard fixed to true in v1; false is rejected because host-loss recovery requires shadow authority. |
| `TAPKART_ANDROID_PACKAGE` | string | no | `""` | Read by the container entrypoint's assetlinks generator, never by the server. |
| `TAPKART_SHA256_FINGERPRINTS` | csv | no | `""` | Comma-separated signing-certificate fingerprints, read by the same generator and never by the server. |

## The STUN default is a third-party endpoint

`ICE_SERVERS` defaults to `stun:stun.l.google.com:19302`, a third-party endpoint
contacted when peers attempt a direct WebRTC connection. This discloses a peer's
address to that service.

Use a different service by setting one variable, for example:

```text
ICE_SERVERS=stun:stun.example:3478
```

Set `ICE_SERVERS=` to opt out. Direct connections may then be limited to the
same LAN; the WebSocket relay remains available.

## Shadow authority is required in v1

`SHADOW_ENABLED` remains recognised as a compatibility guard, but it is not a
feature toggle in v1. Its only accepted value is `true`; setting it to `false`
stops startup with a clear error rather than running races without host-loss
recovery.

## Why failed joins are limited per room code

Room codes are five characters from a 32-symbol alphabet and rooms are
short-lived. Failed joins are nevertheless bounded per room code, never per IP.
A tunnel or reverse proxy can make every user share one source address, so an
IP-keyed limit would turn a busy deployment into a self-inflicted outage.

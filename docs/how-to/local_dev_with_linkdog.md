# Local development against sibling repos (`npm link`)

If you are hacking on `@dogsvr/dogsvr` / `@dogsvr/cl-tsrpc` / `@dogsvr/cl-grpc` / `@dogsvr/cfg-luban` / `@dogsvr/logger` alongside `example-proj`, link them instead of publishing to npm.

## Setup

In each sibling repo that you want to consume from source, publish it as a local link once:

```sh
cd ../dogsvr    && npm run build && npm link
cd ../logger    && npm run build && npm link
cd ../cl-tsrpc  && npm run build && npm link
cd ../cl-grpc   && npm run build && npm link
cd ../cfg-luban/cfg-luban && npm run build && npm link
```

Then, from `example-proj`:

```sh
npm run linkDog
```

Which expands to:

```sh
npm link @dogsvr/dogsvr @dogsvr/cl-tsrpc @dogsvr/cl-grpc @dogsvr/cfg-luban @dogsvr/logger
```

After that, imports of `@dogsvr/*` inside `example-proj` resolve to the sibling repo's compiled `dist/`, so edits in the sibling picked up as soon as you rebuild that sibling.

## `example-proj-cfg` is different

`example-proj-cfg` is consumed via `file:../example-proj-cfg` (see `package.json`), not via `npm link`. `npm install` wires the symlink directly — no separate step required. Rebuild `example-proj-cfg` and its updated `dist/lib/*` is visible to `example-proj` immediately.

## Client-side

`example-proj-client` has its **own** `linkDog` script for the client-facing package set (`@dogsvr/cl-tsrpc` etc.). Run it from inside `example-proj-client/`; it is independent from the server-side one above.

## Unlink

```sh
npm unlink --no-save @dogsvr/dogsvr @dogsvr/cl-tsrpc @dogsvr/cl-grpc @dogsvr/cfg-luban @dogsvr/logger
npm install
```

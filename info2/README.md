# info2 secure-write candidate patch

This is a local, un-deployed candidate for `info2.wabicat.kdns.fr`, prepared against public repository `CanesMueu1900/wabicat-info-site` at commit `2dfec5972779f152db5d665c879a7ce23fa4b5b5` (read-only clone). It changes no live Netlify, Cloudflare, GitHub, or production content. The original `info` deployment and its data remain outside this package and are untouched.

## Scope and data safety

- Public `GET /api/health`, `GET /api/items` and `GET /api/items/:id` retain the current response shapes and list pagination fields (`items`, `total`, `offset`, `limit`, `hasMore`). The list remains sorted newest first.
- `POST /api/items`, `PATCH`/`PUT /api/items/:id`, and `DELETE /api/items/:id` require a bearer token (the legacy `X-Admin-Token` header is also accepted); auth is checked before reading the data store or request body.
- Writes require both Netlify `CONTEXT=production` and the exact `info2.wabicat.kdns.fr` host. Deploy previews/branch deploys fail closed even if a key is accidentally present.
- Production and preview stores are separate. Preview storage is deployment-ID scoped, and no preview dataset is bundled. If no store exists, reads/writes return an error; the function never silently seeds or resets data.
- Storage updates use strong reads and conditional ETags. A concurrent write returns 409 instead of overwriting someone else's update.
- No admin web UI or CORS allowance is added. The key travels only in an HTTPS request header; this avoids browser persistence, frontend exposure, and permissive cross-origin access.
- The code never logs the key or includes it in response bodies. API responses use `no-store` except the public list's existing short public cache.

## Local tests

Requires Node.js 20+ (the tests use Node's built-in test runner):

```sh
npm test
```

Tests use six synthetic fixture rows and a fake in-memory Blob store; no live articles, keys, services, or external writes are used. They cover reads and response contract, missing/wrong/short key, preview/hostname gates, no implicit store initialization, create/edit/delete, field/body validation, secret non-echo, and conditional-write conflict.

`npm run build` also runs the tests and syntax checks. Netlify's `@netlify/blobs` package is pinned in `package.json`; the production adapter is deliberately not invoked by the local tests.

## Future deployment prerequisites (not performed)

Before any outside change, review the exact patch, then separately authorize deploying it to the existing Netlify project. If proceeding, create a strong random `ADMIN_API_KEY` through Netlify's secure environment-variable UI with **Functions** scope and **Production only** context; never put it in build variables, code, Git, a preview context, URLs, browser storage, logs, or chat. Leave the variable absent from Deploy Preview and Branch Deploy scopes. The runtime additionally gates writes on production context and the exact custom host.

Before enabling production reads/writes, the existing six live items must be backed up and explicitly imported into the isolated production Blob store with a reviewed, verified migration. This patch intentionally contains no real dataset and performs no auto-import. Review must also confirm `info2` reads the correct store, HTTPS remains valid, the original `info` site is unchanged, and Deploy Previews contain no real content.

## Wabi publishing limitation

This patch gives a trusted caller an authenticated API with no cross-origin browser access, but current Wabi tools do not provide a safe server-to-server mechanism for attaching the Netlify-only admin key to a write request. A production environment variable alone does not let Wabi publish. Do not route the key through browser JavaScript, a preview, a URL, chat, or a generic tool. Until an approved secure Wabi-to-Netlify credential broker exists, Wabi-authored publishing remains unavailable; a human may use a separately reviewed secure local client after the key is configured.

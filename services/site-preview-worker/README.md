# Self-Hosted Site Preview Worker

This optional Cloudflare Worker accepts authenticated static-site uploads,
stores them in an operator-owned R2 bucket, and serves each site from a
subdomain.

It is not a Bytro-hosted service. You are responsible for the Cloudflare
account, domain, access policy, retention, security, and cost.

## Data and trust boundary

The desktop application receives only:

- the public Worker API URL; and
- an upload API key.

The Worker receives:

- a site identifier;
- paths, content types, and base64-encoded static files; and
- the upload key in the `X-API-Key` header.

Cloudflare account credentials and R2 authorization remain in Wrangler or the
Cloudflare platform. Never put them in the desktop `.env` file.

Published preview files are public to anyone who knows their URL. Do not upload
credentials, environment files, source maps containing confidential source,
customer data, or private assets.

The reference implementation rejects symbolic links, non-canonical paths,
hidden files, and source maps. It limits a deployment to 500 files, 5 MiB per
file, and 50 MiB total decoded content. Upload requests are deliberately kept
below 8 MiB of encoded file data.

Files are uploaded under a unique deployment version. They do not become
public until the desktop calls the finalize endpoint, which atomically switches
the site's active deployment pointer. A failed or incomplete upload therefore
does not replace the currently published site.

## Prerequisites

- a Cloudflare account with Workers and R2 enabled;
- Wrangler authentication for that account;
- a domain managed in the same Cloudflare account; and
- Node.js 22 or newer for the current Wrangler release.

Install dependencies:

```bash
npm ci
```

## Create R2 buckets

The example uses separate production and preview bucket names:

```bash
npx wrangler r2 bucket create bytro-preview-assets
npx wrangler r2 bucket create bytro-preview-assets-preview
```

You may choose different names. Update both names in your local
`wrangler.toml`.

## Configure the Worker

Create a local Wrangler configuration:

```bash
cp wrangler.example.toml wrangler.toml
```

Edit every `example.com` value and both bucket names. Keep `wrangler.toml`
local; it is ignored in this service directory so account-specific routes are
not accidentally published.

The intended DNS layout is:

```text
preview.your-domain.example
*.preview.your-domain.example
```

Both names must be proxied and routable by Cloudflare. The base host serves the
upload/delete API. Generated sites use a single label beneath that host.

## Configure the upload secret

Generate a unique random value:

```bash
openssl rand -hex 32
```

Store it as a Worker secret:

```bash
npx wrangler secret put UPLOAD_API_KEY
```

Paste the generated value when prompted. Do not put the production value under
`[vars]` in `wrangler.toml`.

Configure the same value only on the desktop machine:

```dotenv
BYTRO_DEPLOY_WORKER_URL=https://preview.your-domain.example
BYTRO_DEPLOY_API_KEY=<same-generated-value>
```

## Local development

Copy the local secret template:

```bash
cp .dev.vars.example .dev.vars
```

Set a development-only `UPLOAD_API_KEY`, then start Wrangler:

```bash
npm run dev
```

R2 development storage is local unless Wrangler is explicitly configured for
remote resources.

Check TypeScript:

```bash
npm run typecheck
npm test
```

## Deploy

After reviewing the local configuration:

```bash
npm run deploy
```

Verify:

- an unauthenticated `POST /api/deploy` returns `401`;
- a valid authenticated upload can be finalized to return the expected site URL;
- a published site is served only beneath the configured domain;
- traversal paths and invalid site identifiers are rejected;
- deletion requires the same upload key; and
- logs contain no API key or uploaded file contents.

The upload protocol uses:

- `POST /api/deploy` to add a small batch to an isolated deployment version;
- `POST /api/deploy/finalize` to validate the complete version and atomically
  make it active; and
- `DELETE /api/sites/<site-id>` to delete the active pointer and all retained
  deployment data for a site.

## Rotate the upload key

Run `npx wrangler secret put UPLOAD_API_KEY` again and update the desktop's
local configuration. Existing static sites remain stored; only upload and
deletion authorization changes.

## Delete data

Use the authenticated delete endpoint for a site or remove objects directly
from R2. Establish your own retention policy and monitor bucket usage.

## Production hardening

The shared upload key is suitable for a small, operator-controlled deployment,
not a multi-tenant public service. For broader exposure, add per-user
authentication, rate limits, stricter edge limits where appropriate, audit
logging without secrets, abuse controls, and an explicit retention policy.

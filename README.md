# plume

A 100% client-side blogging platform for Solid. Light as a feather.

**Live**: [solid-apps.github.io/plume](https://solid-apps.github.io/plume/)

## Why

WordPress is the most successful publishing platform ever built — and it owns 40% of the web because it nailed five things: 5-minute install, themes you can swap, plugins you can extend, backwards compatibility for life, and a story that grew from "blog" into "everything."

Plume is the same shape — minus the parts that don't translate to a world where users own their data:

- **Data lives on your pod, not a database.** Every post is a `schema:BlogPosting` JSON-LD resource at `<your-pod>/public/post/<slug>.jsonld`. Any pod-aware app can read it. You can replace Plume with another blogging app tomorrow and your content is still there.
- **The reader is the runtime.** Visit `solid-apps.github.io/plume/?pod=https://alice.solidcommunity.net` and you're reading alice's blog. Visit it with `?pod=https://bob.solidcommunity.net` and you're reading bob's. Same UI, different pod, different blog.
- **Federate without bridges.** Comments, mentions, replies live as resources on the responder's pod — discoverable via WebID and TypeIndex, federated by the open web instead of a vendor.
- **No PHP, no MySQL, no plugins-as-attack-surface.** Plume is a small bundle of HTML + CSS + JS. JSS does the rest.

## Status

Phase 1 (PoC). Write + read + list posts. Markdown via `marked`. xlogin auth (Solid OIDC + Nostr).

## Roadmap

| Phase | Scope |
|---|---|
| **1 — PoC** | Compose markdown post; save to `/public/post/`; index page lists posts; permalink view; xlogin auth |
| 2 | Edit / unpublish (PUT existing post; soft-delete) |
| 3 | Categories + tags (`?tag=solid` filtered listing) |
| 4 | RSS / Atom feed derived from the container listing |
| 5 | Comments — per-post sub-container, each comment a `schema:Comment` federated via WebID |
| 6 | Multi-author blogs — pod publishes a `schema:Blog` with `schema:author` list; other authors post via WAC |
| 7 | Webmention / federation — outbound webmentions, inbox endpoint, optional ActivityPub bridge |
| 8 | Mashlib pane — any `schema:BlogPosting` URL renders via plume's BlogPostingPane inside hub-mashlib |

## Data shape

Each post is one resource at `/public/post/<slug>.jsonld`:

```json
{
  "@context": { "schema": "https://schema.org/" },
  "@id": "",
  "@type": "schema:BlogPosting",
  "schema:headline": "First Post",
  "schema:articleBody": "...markdown body...",
  "schema:datePublished": "2026-05-20T10:00:00Z",
  "schema:author": { "@id": "https://alice.pod/profile/card#me" }
}
```

The `articleBody` is markdown. Plume renders it client-side; other apps can render it however they like, or treat the post as plain text.

## URL params

- `?pod=https://alice.pod` — read another pod's blog (your Plume install becomes a reader for any blog on any pod)
- `?post=<resource-url>` — permalink for a single post
- `?new` — compose a new post (requires login)

## Sibling apps

- [`solid-apps/plaza`](https://github.com/solid-apps/plaza) — group chat
- [`solid-apps/timeline`](https://github.com/solid-apps/timeline) — Facebook-style social feed
- [`solid-apps/hub`](https://github.com/solid-apps/hub) — multi-app workspace
- [`solid-apps/explorer`](https://github.com/solid-apps/explorer) — file manager
- [`solid-chat/app`](https://github.com/solid-chat/app) — direct messaging

## Inspired by

The original [solid-plume](https://github.com/happybeing/solid-plume) by happybeing — the same thesis (decoupled data, replaceable app), modernised for the JSON-LD-first / xlogin-auth / suite-coherent solid-apps shape.

## Local dev

```bash
git clone https://github.com/solid-apps/plume.git
cd plume
python3 -m http.server 8006
# open http://localhost:8006/?pod=http://localhost:4443
```

## License

AGPL-3.0-only

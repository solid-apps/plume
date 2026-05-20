# plume

A blog that lives on your Solid pod.

**[solid-apps.github.io/plume](https://solid-apps.github.io/plume/)**

---

## The idea

WordPress made publishing easy. Plume aims for the same simplicity, with one
change: **your posts are not in a database** — they're plain JSON-LD files
on a Solid pod that you own. The reader app and the data are decoupled.
Swap plume for another blog app tomorrow and your posts come with you.

The same plume install can read any blog on any pod:

- `solid-apps.github.io/plume/?pod=https://alice.solidcommunity.net` reads alice's blog
- `solid-apps.github.io/plume/?pod=https://bob.example` reads bob's
- Same UI, different pod, different blog

Log into your own pod and `+ Write` appears in the corner.

## What works today

- **Write** — markdown editor with live preview (toggle with `⌘ + P`); posts saved as `schema:BlogPosting` JSON-LD
- **Read** — clean reader with serif typography, drop cap, per-blog masthead pulled from the owner's WebID profile
- **Edit / delete** — only the original author sees the controls
- **Tags** — `?tag=solid` filters the index; chips appear on cards and permalinks
- **Comments** — federated by pod: each comment is a `schema:Comment` on the responder's storage, but linked back to the post via `schema:about`
- **Enable Comments toggle** — the post author flips a WAC ACL granting `acl:Append` to authenticated users on the per-post comment container
- **Atom feed** — real `feed.xml` lives on the pod; any RSS reader can subscribe; auto-discoverable via `<link rel="alternate">`
- **Multi-auth** — Solid OIDC and Nostr (via [xlogin](https://github.com/solid-contrib/xlogin))
- **Per-pod identity** — same plume URL transforms into "alice's writing" or "bob's writing" based on the owner's pod profile

## How data is laid out

Every post is one resource:

```
<pod>/public/post/<slug>.jsonld
```

```json
{
  "@context": { "schema": "https://schema.org/" },
  "@id": "",
  "@type": "schema:BlogPosting",
  "schema:headline": "First Contact",
  "schema:articleBody": "...markdown body...",
  "schema:datePublished": "2026-05-20T10:00:00Z",
  "schema:dateModified": "2026-05-21T09:14:00Z",
  "schema:author": { "@id": "https://alice.pod/profile/card#me" },
  "schema:keywords": ["solid", "blogging"]
}
```

Comments mirror the same idea:

```
<pod>/public/comment/<post-slug>/<timestamp>-<rand>.jsonld
```

```json
{
  "@context": { "schema": "https://schema.org/" },
  "@id": "",
  "@type": "schema:Comment",
  "schema:text": "Great post!",
  "schema:dateCreated": "2026-05-20T11:02:00Z",
  "schema:author": { "@id": "https://bob.pod/profile/card#me" },
  "schema:about": { "@id": "https://alice.pod/public/post/first-contact.jsonld" }
}
```

The Atom feed is at `<pod>/public/post/feed.xml` and is regenerated on
publish, edit, or delete.

## URL parameters

| Param | Effect |
|---|---|
| `?pod=https://alice.pod` | Read another pod's blog — plume becomes a reader for any blog on any pod |
| `?post=<resource-url>` | Permalink for a single post |
| `?tag=<tag>` | Filter index by tag |
| `?new` | Compose (requires login) |
| `?edit=<resource-url>` | Edit (author only) |

## Roadmap

| Phase | Scope | Status |
|---|---|---|
| 1 | Write / read / list | shipped |
| 2 | Edit / delete | shipped |
| 3 | Tags / categories | shipped |
| 4 | Atom feed | shipped |
| 5 | Comments | shipped |
| 6 | Multi-author blogs (`schema:Blog` with author list, WAC-gated co-authors) | planned |
| 7 | Webmention / federation (outbound + inbox endpoint, optional ActivityPub bridge) | planned |
| 8 | Mashlib pane — any `schema:BlogPosting` URL renders via plume inside hub-mashlib | planned |

## Run it locally

```bash
git clone https://github.com/solid-apps/plume.git
cd plume
python3 -m http.server 8006
# open http://localhost:8006/?pod=http://localhost:4443
```

No build step, no dependencies, no server. plume is HTML, CSS, and one
ES module. Everything talks to your Solid pod over HTTP.

## Sibling apps in the suite

- [hub](https://github.com/solid-apps/hub) — multi-app workspace and file mode for any Solid resource
- [explorer](https://github.com/solid-apps/explorer) — file manager with split panes and per-resource ACL editor
- [plaza](https://github.com/solid-apps/plaza) — Slack-style group chat
- [timeline](https://github.com/solid-apps/timeline) — Facebook-style social feed
- [solid-chat/app](https://github.com/solid-chat/app) — direct messaging

## Inspired by

[solid-plume](https://github.com/happybeing/solid-plume) by happybeing —
same thesis (decoupled data, replaceable app), updated for the
JSON-LD-first, xlogin-auth, suite-coherent shape of solid-apps.

## License

[AGPL-3.0-only](./LICENSE)

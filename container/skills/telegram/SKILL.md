---
name: telegram
description: Format messages for Telegram (HTML rendering) and use native reply / quoted-reply features.
---

# Telegram

Telegram outbound is sent with `parse_mode=HTML`. **No Markdown.** Backticks, asterisks, underscores, `[text](url)`, `# heading`, `- bullet` — every one of those renders as literal characters in the user's chat. Before sending, scan for those five patterns; if you find one, rewrite the span with the HTML tag from the table below.

Applies only when the channel is Telegram (`channel_type=telegram`, or thread id starts with `telegram:`). On other channels use whatever's idiomatic there.

## Markdown → HTML

| You'd typically write | Send instead |
|---|---|
| `` `code` `` | `<code>code</code>` |
| ` ```lang\nblock\n``` ` | `<pre><code class="language-lang">block</code></pre>` |
| `**bold**` | `<b>bold</b>` |
| `_italic_` | `<i>italic</i>` |
| `~~strike~~` | `<s>strike</s>` |
| `[label](https://x.com)` | `<a href="https://x.com">label</a>` |
| `# Heading` | `<b>Heading</b>` (no heading tag exists) |
| `> quote` | `<blockquote>quote</blockquote>` |
| `- item` | `• item` (no list tag — use a Unicode bullet) |

### A few more tags Telegram supports

- `<u>underline</u>`
- `<blockquote expandable>long quote — collapses behind a tap</blockquote>`
- `<tg-spoiler>hidden until tapped</tg-spoiler>`
- `<a href="tg://user?id=12345">name</a>` — inline mention by user id

That's the complete set. Paragraphs are `\n\n`, line breaks are `\n` — there's no `<p>` or `<br>`. Don't nest `<code>` inside `<code>` or `<pre>` inside `<pre>`; Telegram drops the inner one.

### Escaping

Outside of tags, escape `&` → `&amp;`, `<` → `&lt;`, `>` → `&gt;` in anything that came from a variable, user input, or scraped content. Inside `<code>` / `<pre>` you still need to escape `<` and `>` if they appear literally in the content.

## Link previews

Off by default. Include the literal token `[[link-preview]]` anywhere in the text to enable a preview for the first chunk; the adapter strips the token before sending. Use sparingly — for most links a clean `<a>` tag is what the reader wants.

## Native reply (`reply_to_seq`)

`send_message({ text, reply_to_seq: <id> })` attaches the reply as a Telegram-native quoted reply (with tap-to-jump and a one-line preview of the target). The value is the `id` from `<message id="N">` blocks — works for both your own past messages and the user's.

Use it **only when the reference is non-obvious** — the user asks you to find or recall something, you're citing a message many turns ago, or you're anchoring to a specific past statement. Don't tag every reply; adjacency already signals the obvious case, and a reply tag on every message is noise.

If the seq doesn't resolve (e.g. an outbound message that never delivered), the host silently sends without the reply tag — `send_message` doesn't error.

## Highlighted-quote reply (`quote_text`)

Pair `quote_text` with `reply_to_seq` to highlight a fragment of the target message instead of previewing its opening line:

```
send_message({
  text: "About this part:",
  reply_to_seq: 12,
  quote_text: "the exact substring from message 12",
})
```

- `quote_text` requires `reply_to_seq`.
- Must be an **exact substring** of the target message's plain text (no formatting, no paraphrase). Telegram validates server-side; on mismatch the adapter retries without the quote, so the reply still lands but the highlight is lost.

Use when addressing a specific sentence in a long message, a single bullet in a list, or a phrase the user asked you to find. For short messages a plain `reply_to_seq` already anchors the whole thing — skip the quote.

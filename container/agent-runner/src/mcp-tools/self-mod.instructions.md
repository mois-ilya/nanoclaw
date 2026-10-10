## MCP servers (`add_mcp_server`)

Use **`add_mcp_server`** to connect an existing remote MCP server to your configuration. The owner approves each request on a card.

```
add_mcp_server({ name: "remote", url: "https://example.com/mcp" })
```

Only a remote Streamable HTTP server with an **HTTPS** `url` that needs **no secrets** is supported. Local commands (`command`, `args`, `env`), headers, and URLs carrying credentials or tokens are rejected.

Secrets are not supported yet (a future Mini App feature). Do not ask the user for API keys or tokens, and do not invent credential setup steps: if a server needs a key, say that it cannot be connected yet.

Packages cannot be installed on this runtime; work with the tools already in the image.

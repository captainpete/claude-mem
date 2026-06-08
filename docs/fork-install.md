# Installing this fork (remote worker mode)

This is a fork of upstream [`thedotmack/claude-mem`](https://github.com/thedotmack/claude-mem)
that adds a `CLAUDE_MEM_WORKER_URL` setting. With it, a client machine can run
claude-mem with **no local worker and no local database** — every observation
and memory query is sent to a single shared worker running on another machine.

Upstream claude-mem is single-machine only, so to use a shared worker you must
install this fork on each client. The host machine that runs the shared worker
can use either this fork or stock claude-mem.

> Once installed, see [Remote worker mode](https://docs.claude-mem.ai/configuration#remote-worker-mode)
> in the configuration docs for the settings reference. This page only covers
> getting the fork onto a machine.

## What the fork adds

- A `CLAUDE_MEM_WORKER_URL` setting. Empty (default) = local mode, unchanged
  from upstream. Any non-empty value = remote mode.
- In remote mode the worker spawner short-circuits: no PID file, no daemon
  spawn — just a health check against the URL.
- `start` / `stop` / `restart` / `--daemon` exit early in remote mode.
- Health checks accept a base URL (hostname or `http(s)://` URL) instead of a
  bare port, so loopback URLs work (handy when a client reaches the worker
  through an SSH tunnel on `localhost`).

## 1. Prerequisites

- **Bun** — `command -v bun || curl -fsSL https://bun.sh/install | bash`
- **Node.js** and **git**
- Network reachability from each client to the host worker (same LAN, VPN/mesh,
  or an SSH tunnel — see step 4).

## 2. Clone and build the fork

```sh
git clone https://github.com/captainpete/claude-mem.git
cd claude-mem
npm install
npm run build        # regenerates plugin/scripts/*.cjs from the TypeScript sources
```

Pick a stable location for the checkout — the install in the next step points at
it, so don't delete or move it afterwards.

## 3. Swap the fork in over the installed plugin

Claude Code loads the plugin from
`~/.claude/plugins/marketplaces/thedotmack/plugin`. Replace that directory's
contents with the fork's `plugin/` directory. The symlink approach is the
easiest to revert:

```sh
PLUGIN_DIR="$HOME/.claude/plugins/marketplaces/thedotmack/plugin"
FORK_PLUGIN="$(pwd)/plugin"     # run from the fork checkout root

# Back up whatever is there now, then symlink the fork in its place
mv "$PLUGIN_DIR" "$PLUGIN_DIR.bak"
ln -s "$FORK_PLUGIN" "$PLUGIN_DIR"

# Clear the cached copy so the new plugin loads fresh
rm -rf "$HOME/.claude/plugins/cache/thedotmack/claude-mem"
```

If `~/.claude/plugins/marketplaces/thedotmack` doesn't exist yet, install stock
claude-mem first (`/plugin marketplace add thedotmack/claude-mem` then
`/plugin install claude-mem` inside Claude Code) so the directory layout exists,
then do the swap above.

Record your rollback steps (the `.bak` path) before moving on.

## 4. Make the client reach the worker

The client needs `CLAUDE_MEM_WORKER_URL` to resolve to a running worker. Two
common setups — use whichever fits your network:

**Direct (same LAN / VPN / mesh):** point the URL straight at the host. On the
host, set `CLAUDE_MEM_WORKER_HOST` to `0.0.0.0` so the worker binds all
interfaces, and restart it. Then the client URL is `http://<host>:<port>`.

**SSH tunnel:** forward a local port to the host's worker port, then point the
URL at the local end of the tunnel:

```sh
ssh -fN -L <port>:127.0.0.1:<port> <user>@<host>
curl -s http://localhost:<port>/api/health   # should return {"status":"ok",...}
```

Because the fork allows loopback URLs, `http://localhost:<port>` works as the
remote URL even though it points at a tunnel.

> The default worker port is `37700 + (uid % 100)`. Set `CLAUDE_MEM_WORKER_PORT`
> explicitly if you want a fixed, predictable port on both ends.

## 5. Configure remote mode on the client

Edit `~/.claude-mem/settings.json` (create it if missing) and merge in the URL
that resolves to your worker from step 4:

```json
{
  "CLAUDE_MEM_WORKER_URL": "http://<host-or-localhost>:<port>"
}
```

Then stop any stray local worker so it doesn't compete:

```sh
pid=$(jq -r '.pid // empty' ~/.claude-mem/worker.pid 2>/dev/null)
[ -n "$pid" ] && kill "$pid" 2>/dev/null
rm -f ~/.claude-mem/worker.pid
```

## 6. Restart and verify

Quit and relaunch Claude Code — hooks read settings at process start, so without
a restart you'll be running mixed state.

- **Confirm remote mode in the log:**
  ```sh
  tail -50 ~/.claude-mem/logs/worker-$(date +%Y-%m-%d).log
  ```
  It should indicate remote mode and should **not** contain `Worker started`.

- **Confirm hooks reach the host:** run a few prompts, then check that the
  observation count for your project ticks up on the host:
  ```sh
  bun ~/.claude/plugins/marketplaces/thedotmack/plugin/scripts/statusline-counts.js <project-name>
  ```

## Roll back

```sh
# 1. Remove the setting
jq 'del(.CLAUDE_MEM_WORKER_URL)' ~/.claude-mem/settings.json \
  > ~/.claude-mem/settings.json.tmp \
  && mv ~/.claude-mem/settings.json.tmp ~/.claude-mem/settings.json

# 2. Restore the original plugin directory
PLUGIN_DIR="$HOME/.claude/plugins/marketplaces/thedotmack/plugin"
rm -f "$PLUGIN_DIR"            # remove the symlink
mv "$PLUGIN_DIR.bak" "$PLUGIN_DIR"

# 3. Tear down the SSH tunnel if you used one
#    pkill -f 'ssh -fN -L <port>:127.0.0.1:<port>'

# 4. Quit and relaunch Claude Code.
```

## Keeping the tunnel alive across reboots

If you use an SSH tunnel, a bare `ssh -fN -L` dies when the host reboots or the
network drops, and the client's hooks will briefly fail until you re-open it.
Replace it with `autossh` (plus a per-OS service/agent that launches it on
login) so the tunnel reconnects automatically and the unreachable window
shrinks to near zero.

# magpie-freepi

A [magpie](https://usemagpie.ai) provider plugin for [free-pi](https://freepi.ai) (`api.freepi.ai`), the ad-supported free model gateway. Talks straight to the upstream — no local proxy, no extra process.

Unofficial; the protocol was reverse-engineered from free-pi-cli (same shape as [FreePi2API](https://github.com/ErfanBagheri404/FreePi2API)).

## Features

- **Direct upstream**: credentials live in magpie's `plugin-auth.json` (mode 600); requests ride magpie's proxy chain for this provider (switchable to direct via options).
- **GitHub device-code sign-in**: click login in the app, enter the code in your browser — no API key.
- **Live model catalog** (26 available models at the moment) with free/usage-rate badges from the upstream, falling back to a built-in static list when unreachable.
- **Real daily quota**: the account card shows free-pi's daily credits and its UTC-midnight reset, so routing can weigh the account.
- **Automatic ad impressions**: free-pi only serves completions when the client reports banner impressions; the plugin fetches one banner and reports the impression before each request (never clicks, never blocks, failures are swallowed). The count is visible on the account card.

## Install

```sh
magpie plugin add github:aqiu817/magpie-freepi   # or a local folder path
magpie plugin login freepi                        # finish the GitHub device flow in your browser
magpie provider test freepi
```

In the app: Plugins → Add → enter the path/repo → sign in on the freepi row.

## Models

Check the live list in magpie's model picker. The upstream name carries badges the plugin converts:

- 🔥 **Free Unlimited** (limited time): `deepseek-v4-flash`, `deepseek-v4.1-flash`, `glm-5.3-flash`, `particle`
- **Rated models** (`~Nx usage`): e.g. `claude-haiku-5.5` (2x), `solar-pro-4` (0.6x), `gpt-6.1-sol-flex` (41x); plus ~7 uncensored/abliterated fine-tunes (upstream "defense" section, 20–60x)

Context/output limits come from [models.dev](https://models.dev) (matched via the upstream `stats_id`): most models are ~1M context, `gpt-oss-120b-speed` is 32k; unmatched entries default to 128k/16k. The upstream may still cap per request.

## Options

Set as JSON under Plugins → Installed → freepi options (or `magpie plugin options freepi '{"direct":true}'`):

| Option | Default | Description |
|---|---|---|
| `direct` | `false` | Bypass magpie's proxy chain and hit the upstream directly |
| `adCount` | `true` | Show an aside window with this run's reported impression count (never used by routing) |

## Disclaimer

- **Unofficial**: not affiliated with free-pi; the protocol is reverse-engineered and consent/version/ad endpoints may change and break at any time.
- **Ads**: free-pi pays for inference with ad revenue. The plugin mirrors what headless proxies do — report banner impressions automatically (impressions only, never clicks). Use the official CLI if you'd rather support the service with real browsing.
- **Data**: the upstream marks `muse-spark-1.3-contributor` as training on your data (free-pi + Meta), and sign-in requires consenting to sessions possibly being used for training.
- **Quota**: rated models consume daily credits per the upstream's rules; exhausted credits fall back to a slower lane or a wait.
- Personal use only.

## Development

```sh
node --test test/freepi.test.mjs
```

```
index.mjs            # entry: FreePiPlugin (the only plugin export) + _internal
lib/upstream.mjs     # upstream contract: constants/version pin/headers/device flow/ad gate
lib/catalog.mjs      # static model table + catalog parsing + models.dev limits
test/                # node:test with mocked fetch, no real network
```

## License

MIT

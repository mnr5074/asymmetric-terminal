# Tax desk (Asymmetric Terminal)

Private tax module: `Tax` tab in the top nav (behind the site password; refused unless SITE_PASSWORD is set or the request is from localhost).

## Files
- `lib/tax/api.js` – routes under `/api/tax/*` (mounted by one line in server.js)
- `lib/tax/store.js` – private ledger `data/tax/ledger.json` (dir 0700, files 0600, gitignored + dockerignored)
- `lib/tax/chain.js` – wallet history: Solana public RPC (getSignaturesForAddress/getTransaction, swap parsing from balance deltas; Helius only if HELIUS_API_KEY already set); EVM via Etherscan V2 (only if ETHERSCAN_API_KEY set; free tier excludes Base/BSC/OP), keyless Blockscout `/api`, keyless Routescan (Ethereum, Avalanche). BSC: no free API → import BscScan "Download CSV".
- `lib/tax/csv.js` – Coinbase, Kraken (ledgers/trades), Binance.US (tax export / trade history), Etherscan-family explorer CSVs, generic column mapper
- `lib/tax/transfers.js` – internal transfer matching (txid, or asset+amount within 2% within 72 h)
- `lib/tax/prices.js` – historical USD: stablecoins $1, Coinbase Exchange hourly candles, Binance public daily, CoinGecko free (≤365 d), GeckoTerminal daily
- `lib/tax/lots.js` – FIFO/LIFO/HIFO, per-wallet or universal, fees in basis/proceeds, ST/LT, income at FMV, wash sales (securities always; crypto toggle off / H.R. 10357 scenario / on)
- `lib/tax/estimate.js`, `tables.js` – 2026 federal (Rev. Proc. 2025-32), $3,000 loss limit + carryforward, NIIT; Nevada = $0
- `lib/tax/harvest.js` – harvesting ideas, worthless-token flags
- `lib/tax/report.js`, `pdf.js`, `context.js` – Form 8949 CSV, zero-dependency PDF, on-chain context from live feed / crash catalog / rug cases
- `lib/tax/sample.js` + `research/tax_sample/make_sample.js` – EXAMPLE DATA generator (`node research/tax_sample/make_sample.js`)
- `public/tax.js` – the panel

Estimates only; not tax advice.

# 2029

A local Bitget portfolio dashboard for unleveraged spot wallets, classic spot cross margin, isolated USDT perpetual positions, and individual crypto loans. Built with React, TypeScript, Vite, Decimal.js, IndexedDB, and TradingView Lightweight Charts.

## Run locally

Use Node.js 22.12 or newer. From this directory run

```sh
npm ci
npm start
```

Open [the local dashboard](http://127.0.0.1:2029/). The app binds to the loopback interface on port 2029. Use the same browser profile and URL on later visits to access the same IndexedDB portfolio. The first launch starts empty.

Use the language selector beside Portfolio settings to switch between English and 简体中文. The choice is saved in this browser and applies across open tabs.

## Working with your portfolio

- **Live** restores saved accounts on each launch. Quotes refresh every 45 seconds and chart candles refresh every minute. Account cards in Overview and Accounts show effective leverage, the estimated BTC liquidation price along the Base path, and net equity in USDT. Expand a card for holdings, debt or margin, and asset-specific risk details. Balance-edit and quote timestamps are shown separately.
- **Add account → Spot wallet** records available BTC, ETH, SOL, BNB, HYPE (Hyperliquid), USDT, or another Bitget spot asset. Enter each holding once in the account that holds it. Record collateral already pledged to a loan in that loan's account.
- The spot-margin and loan debt fields accept pasted balances such as `-1,500.00`. The editor previews the positive USDT amount owed before you save.
- **Pending orders** lets you record limit buys and sells against a spot cross margin account or an isolated perpetual position. Add an order from the overview or its account's details. Tick orders to assume full fills in list order at their individual limits. The overview and Accounts page revalue the resulting positions at current Bitget spot or mark prices. Clear fill assumptions to restore the Live view in one click. Order definitions persist in local storage and backups. Reloading starts with every order unchecked. The price simulator and cash planner use the saved holdings.
- For a spot buy, select **Borrow missing USDT** to finance the part the account cannot pay from available USDT. Spot sells use owned assets and can repay USDT debt from net sale proceeds. Perpetual fills net against the existing isolated position, update its average entry and credit realized gains or losses to its margin. A full close leaves the resulting USDT balance at that position. Fees are entered as a USDT amount per fill and default to zero. If a fill lacks funds or sellable quantity, the preview identifies the order and skips the selected fills for that account.
- **Your accounts → Sort by** sets the display order for both the overview and the Accounts page. Choose manual order and drag a row by its handle, or focus the handle, press Space, use the arrow keys, and press Space again to save. Reordering a filtered list moves just the visible accounts. Your preferred sort and manual order are saved locally and included in portfolio backups.
- **Simulate** freezes prices from the current market snapshot. Adjust prices directly or select a BTC-linked path. The Live column continues updating. Use **Load scenario** beside **Save scenario**, or on the Live overview, and select a name to restore its frozen prices and adjustments. Each launch opens in Live.
- **Cash planner** opens a separate draft using Live quotes. To fund a specific simulation, choose **Plan using this scenario**. It copies the frozen prices, path, and manual altcoin overrides into a new draft. Changing its BTC target leaves the scenario and standalone draft intact. The assumptions above the cash amount show which prices were used. Funding actions are listed by required transfer, largest first. Expand **No funding needed** to see accounts that already meet the target. Each action identifies its destination, contributions from each source, repayment or margin credit, remaining balance, and estimated before/after trigger. Funding priority is spot margin, individual loans, then isolated perpetuals.
- To edit a saved funding plan, select it in the planner, update its settings, and choose **Save changes**. You can rename it, use **Save as** to keep a separate copy, or choose **Delete plan**. The planner asks for confirmation before overwriting a matching name or deleting a plan.
- Under **Spot funding sources**, choose whether to use existing wallet USDT. To model borrowing, select a wallet and asset, enter the quantity to pledge, and load Bitget's public terms or enter the initial and liquidation LTVs shown on your order. The planner uses available USDT first, then the selected collateral loans in order, then external cash. Older saved plans retain their original funding choices. Saving a plan stores its assumptions. To record a transaction you execute on Bitget, update the wallet, the individual loan, and the receiving account to reflect their new balances.
- **Portfolio settings** provides JSON export/import, archive restoration, and Clear all. Clear all and import each update the whole portfolio in one IndexedDB transaction. Revision checks reject delayed edits and open tabs reload committed changes.

## Valuation and risk

| Account | Price basis | Equity and trigger |
| --- | --- | --- |
| Unleveraged spot wallet | Bitget spot last, USDT at par | Sum of available holdings at spot value. Positive equity has 1× standalone leverage, zero debt and no liquidation trigger. |
| Classic spot cross margin | Bitget spot last, USDT at par | Holdings value less outstanding USDT debt including interest. Risk is 0.10 × debt / equity. The gross-asset liquidation boundary is 1.10 × debt. The dashboard uses the requested personal alert of 0.65 and liquidation at 1.00. |
| Crypto loan | Public Bitget coin/USDT index as a collateral reference estimate | Pledged value less outstanding USDT debt including interest. LTV is debt / pledged value. Each order carries its own warning and liquidation LTVs. Defaults are 85% and 91%. The private order's execution price can differ from the public index. |
| Isolated USDT perpetual | Bitget perpetual mark | Allocated margin plus signed unrealized P&L. The liquidation estimate solves for equity equal to tiered maintenance plus the closing taker fee. The dashboard gives an early warning at 80% utilization of isolated equity. |

Portfolio effective leverage divides the combined gross exposure of spot margin, perpetual and crypto-loan accounts by their combined net equity. Ordinary spot wallets contribute to portfolio net equity and are excluded from both sides of the leverage calculation. The dashboard shows a dash when the included accounts lack a required quote or their combined net equity is zero or negative. Perpetual exposure uses absolute position notional. Tier schedules and public taker fees can be loaded in the perpetual editor, with a manual field for a position-specific fee. After real fills or funding and interest accruals, update the saved balances to record the change.

The scenario, liquidation estimates, and cash planner use the same BTC-linked paths. Base multiplies the BTC percentage move by 1.5 for ETH, 1.7 for both SOL and HYPE, and 1.0 for BNB. Severe uses 2.5 for ETH, 3.0 for both SOL and HYPE, and 1.5 for BNB. Other assets hold their snapshot prices unless individually overridden. Simulated prices floor at zero and relative changes preserve differences between spot, mark, and index prices. A manual altcoin target stays pinned until you choose **Restore BTC link**.

The scenario reports the first warning and liquidation reached on the move from the frozen snapshot. When one asset drives the move, it also shows the next threshold if that asset keeps moving in the same direction. Accounts are ranked on that common path. With multiple independent manual moves, the next event depends on which asset moves next.

Scenario totals assume zero recovery from the first touch of each account's liquidation threshold. The account outcomes show equity at the trigger, before execution and fees, when that crossing can be determined. Actual settlement is unknown. Positions that survive retain their scenario value. The debt comparison shows recorded balances. Changing the target or resetting the scenario recalculates the path from the snapshot.

The cash planner checks the starting prices, the buffered target, and intermediate price floors where combined collateral can be worth less than at either endpoint. Its rounding enforces strict headroom, including an extra executable increment when funding would otherwise land exactly on liquidation. A full debt payoff caps repayment at the balance owed and identifies any excess transferred cash at the destination.

For a proposed collateral loan, the planner caps borrowing at the initial LTV on the live index value and keeps the principal strictly below liquidation at both live and buffered target prices. Loading Bitget terms also applies the published borrowing and collateral value limits. Each loan shows the collateral it locks, principal, target LTV, and liquidation price. If the minimum loan exceeds the required transfer, the unused proceeds are shown separately. Estimates exclude future interest.

Prices and their source timestamps are cached separately from portfolio records. The interface marks stale or missing prices and leaves incomplete equity totals unavailable. The offline BTC daily chart can use a dated capture of public Bitget candles from November 21, 2026. That capture is used exclusively for chart display.

### Official references

- Bitget's classic margin risk equation and liquidation threshold. [Spot margin risk](https://www.bitget.com/support/articles/12560603779331)
- Isolated liquidation, direction, maintenance offset and taker fee. [Estimated liquidation price](https://www.bitget.com/support/articles/12560603808759)
- Public contract risk inputs. [Position tiers](https://www.bitget.com/docs/catalog/classic-contract-position/classic-contract-position) and [contract configuration](https://www.bitget.com/docs/catalog/classic-contract-market/classic-contract-market)
- Borrowing and repayment modes for margin orders, and one-way perpetual order sides. [Cross margin orders](https://www.bitget.com/docs/catalog/classic-margin-cross-trade/classic-margin-cross-trade) and [perpetual orders](https://www.bitget.com/docs/catalog/classic-contract-trade/classic-contract-trade)
- Market tickers, mark/index fields and candle history. [Public market data](https://www.bitget.com/docs/catalog/market/market-data)
- Loan reference valuation and order-specific LTV settings. [Crypto Loans FAQ](https://www.bitget.com/academy/research/articles/12560603795137) and [classic loan API](https://www.bitget.com/docs/catalog/earn-classic-loan/classic-earn-loan)

## Verification

```sh
npm test
npm run build
npx playwright install chromium
npm run test:browser
```

To measure coverage, install Chromium once with `npx playwright install chromium`, then run

```sh
npm run test:coverage
```

The command runs the unit and Chromium suites against an instrumented copy of the application on a separate local port. It combines the results for all executable TypeScript and TSX under `src/`, counting untouched modules in the totals. The terminal shows statement, branch, function and line coverage per file. Open `coverage/index.html` to see the exact lines and branches, or use `coverage/lcov.info` and `coverage/coverage-summary.json` in other tools.

The unit suite covers decimal calculations, position tiers, strict target rounding, budget allocation, missing prices, and storage transactions. Browser tests use isolated profiles and synthetic market responses to exercise manual entry, exact edits, quote failure, saved scenarios, independent cash plans, archive/backup, multi-tab clear, browser restart, and desktop/mobile layouts. Tests operate independently of the user's portfolio.

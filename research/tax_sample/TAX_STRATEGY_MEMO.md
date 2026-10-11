# Crypto & Options Trader Tax Research Memo (US / Nevada)

**Prepared:** October 11, 2026 (PT)  ·  **Purpose:** Research notes for a tax professional. **This is not tax advice.** It summarizes law and IRS guidance as found in public sources on the date above. Confirm every item with a CPA/EA/tax attorney before acting.

**Profile assumed:** Individual US taxpayer; Nevada resident; W-2 employee with a regular job; no business entity; active trader of Solana memecoins on DEXs plus some stock options; large realized and unrealized crypto losses; carries credit card debt.

**Status labels used below**
- **[V]** Verified against a primary source (statute, IRS.gov, Congress.gov/House/JCT documents) during this research.
- **[S]** From a reputable secondary source (CPA/law firm/AICPA/JofA). Not checked against the primary text.
- **[U]** Uncertain, unsettled, or a judgment call. Needs professional review.

---

## 0. Executive summary: the items that matter most

1. **Crypto wash-sale rule: not law today, but a pending bill would apply it retroactively.** Under current law, IRC §1091 covers only "stock or securities" (and options/contracts on them). Crypto is property (Notice 2014-21), so selling at a loss and buying back is not barred by §1091. **[V]** However, **H.R. 10357, the Digital Asset Tax Certainty Act**, was introduced Sept 14, 2026 and approved by House Ways & Means on Sept 16, 2026. As amended in committee, it would apply wash-sale rules to "traded digital assets" for **dispositions after September 14, 2026**. **[V: JCX-50-26 and bill text]** If it is enacted in that form, harvest-and-rebuy trades made since Sept 15, 2026 could lose their losses after the fact. At research time it had not passed the House or Senate and was not law. **[V/U: latest action found was committee approval]**
2. **Tokens from rug pulls that you simply hold, abandon, or treat as "worthless" probably give no deduction for an investor.** IRS Chief Counsel (CCA 202302011) says a §165(a) worthlessness or abandonment loss on crypto is a *miscellaneous itemized deduction* for individuals. **OBBBA §70110 made the suspension of those deductions permanent** for tax years beginning after 2025. **[V]** The practical route is usually an **actual sale** (even for a tiny amount) to a genuine unrelated buyer, which produces a **capital loss** on Form 8949. **[V for sale = disposition; U for how sham-proof any specific "buyer" service is]**
3. **Theft and scam losses:** profit-motivated scams (fake investment platforms, "pig-butchering") can still be deductible under §165(c)(2) (CCA 202511015). Personal (non-profit) theft losses stay disallowed. OBBBA made that limit permanent and added state-declared disasters for casualty losses only. **[V]**
4. **Investment expenses stay non-deductible permanently** (OBBBA §70110). Home office, equipment, data feeds, and software are deductible only if you have **Trader Tax Status (TTS)**, reported on Schedule C. **[V]**
5. **The §475(f) mark-to-market deadline for 2026 has passed.** It was April 15, 2026. The next opening is **April 15, 2027, for tax year 2027**. Under current law §475(f) generally does **not** cover spot crypto, because crypto is neither a "security" nor clearly a "commodity" for this purpose. **[V for the deadline; U/S for crypto]**
6. **Key 2026 numbers** (Rev. Proc. 2025-32) **[V]**:
    - Standard deduction: $16,100 single / $32,200 MFJ.
    - 0% long-term capital gains rate up to $49,450 of taxable income (single); 15% up to $545,500 (single); 20% above that.
    - NIIT of 3.8% above $200k MAGI single / $250k MFJ (thresholds not indexed).
    - Capital loss offset against ordinary income: $3,000 ($1,500 MFS).
7. **Near-term dates:**
    - **Oct 15, 2026:** extended 2025 returns are due.
    - **Dec 31, 2026:** last day to realize 2026 losses.
    - **Jan 15, 2027:** Q4 estimated tax payment.
    - **Apr 15, 2027:** 2026 return due, and deadline for a §475(f) election for 2027.

---

## 1. Capital loss harvesting

### 1.1 Netting mechanics [V]
- Gains and losses are split into **short-term** (held 1 year or less) and **long-term** (held more than 1 year). Each group is netted separately, then the net short-term and net long-term results are netted against each other (Schedule D; Pub 550; Pub 544).
- If the overall result is a **net capital loss**, up to **$3,000** per year (**$1,500 if married filing separately**) offsets ordinary income such as W-2 wages (IRC §1211(b)).
- **Carryforward:** any unused net capital loss carries forward **indefinitely** (IRC §1212(b)) until used. It **keeps its short-term or long-term character**. Use the Capital Loss Carryover Worksheet in the Schedule D instructions. For individuals, carryovers end at death (they cannot pass to heirs). **[V for indefinite and character; the death rule is long-standing law, ask the CPA to confirm]**
- Each carryforward year, short-term carryover losses first offset short-term gains, and long-term losses first offset long-term gains. Losses are worth most against short-term gains, which would otherwise be taxed at ordinary rates.
- **Crypto basics** **[V]**:
    - Digital assets are property (Notice 2014-21; IRS digital assets FAQs).
    - **Every token-to-token swap is a taxable disposition**, including memecoin↔SOL and SOL↔USDC on Jupiter, Raydium, pump.fun, and similar platforms.
    - Network fees and priority fees generally increase basis or reduce amount realized.
- **Form 8949, new digital-asset boxes (2025 forms onward)** **[V]**:
    - Short-term: Box G (1099-DA, basis reported), Box H (1099-DA, basis not reported), Box I (no 1099-DA).
    - Long-term: Boxes J, K, L in the same order.
    - Do **not** use Box C or Box F for digital assets.
    - DEX trades usually fall in **Box I or Box L**.

### 1.2 Wash-sale rule: status as of Oct 11, 2026
| Item | Status |
|---|---|
| §1091 applies to stocks, securities, and **options/contracts to acquire them** (your stock options) | **Current law [V]** (Pub 550). Rev. Rul. 2008-5 applies it to replacement purchases inside an IRA. |
| §1091 applied to crypto/digital assets | **Not current law [V]**. RSM (Sept 30, 2026): "Under current law, investors were not expressly limited by section 1091." **[S]** |
| H.R. 9172 (Arrington, introduced June 8, 2026): wash-sale and constructive-sale rules for digital assets, effective for dispositions after the bill's introduction date | **Introduced only [V]** |
| **H.R. 10357, Digital Asset Tax Certainty Act** (introduced Sept 14, 2026; approved by Ways & Means Sept 16, 2026). §301 extends §1091 to "traded digital assets" other than qualified USD stablecoins, and to options/contracts on them; wrapped/tokenized equivalents count as "substantially identical." | **Proposed, not enacted [V]**. The chairman's substitute (JCX-50-26) sets the wash-sale effective date to **dispositions after September 14, 2026**. A transition rule lets *brokers* ignore §1091 in basis reporting for dispositions before Jan 1, 2028, but that does not change the *taxpayer's* own liability. No House floor vote was found. RSM says Congress is expected to be in recess until after the November midterms. **[V/U]** |

**Planning implications:**
- **Current law:** selling a losing memecoin and buying it back right away is not barred by §1091. **[V]**
- **Legislative risk:** if H.R. 10357 passes as reported, losses on digital-asset dispositions **after Sept 14, 2026** that are followed by a repurchase of the same or a substantially identical asset within 30 days (before or after the sale) would be disallowed. The disallowed loss would be added to the basis of the replacement units, so the loss is deferred rather than permanently lost. **[V: text; U: whether it is enacted and in what form]**
    - A conservative approach for Q4 2026 is to **avoid repurchasing the same token within 30 days** of a loss sale, or to switch to a different, non-identical asset.
    - Retroactive effective dates are sometimes changed before enactment. Ask the CPA to monitor.
- **Economic substance and sham-transaction doctrines still apply** (IRC §7701(o); common-law substance-over-form). **[V statute; U how it would apply]** Risky patterns include:
    - Simultaneous or same-block sell-and-rebuy with no change in economic position.
    - "Sales" between wallets you control. That is not a sale at all.
    - Sales to related parties: losses are disallowed under **§267** (e.g., spouse, family members, controlled entities).
    - Prearranged buybacks.
    - Allowing some real market exposure and time between trades makes the position easier to defend.
- **Stock options (current law):** a loss on stock followed by buying a call on the same stock within 30 days, or selling an option at a loss and reopening a substantially identical option, can trigger §1091. **[V]** Broad-based index options (e.g., SPX) are §1256 contracts, taxed 60% long-term / 40% short-term and marked to market at year-end. A §1256 net loss can be carried back 3 years against prior §1256 gains (§1212(c), Form 6781). **[V statute]**

### 1.3 Worthless and abandoned tokens (rug pulls, dead memecoins)
- **A big drop in price is not a deductible loss.** You need a closed transaction: a sale, a true worthlessness event, or an abandonment that you can prove. **[V: CCA 202302011]**
- **Abandonment** requires intent to abandon **plus an affirmative act** (citing Massey-Ferguson, 59 T.C. 220; Citron, 97 T.C. 200). Simply holding a token, or not using it, is not enough. **[V]**
- **Character problem:** for individual investors, a §165(a) loss from worthlessness or abandonment of crypto (which is not a "security" under §165(g)) is a **miscellaneous itemized deduction** under §67(b)(3), per the IRS's position in CCA 202302011. Those deductions were suspended for 2018–2025, and **OBBBA §70110 made the suspension permanent** for tax years beginning after Dec 31, 2025. **Result: no deduction under current law for an investor.** **[V]** Some practitioners disagree with the CCA's characterization, and a CCA is not binding precedent. **[U]**
- **Practical route: a real sale.** Sell the token for any amount, even a fraction of a cent, through the DEX if any liquidity remains, or to a genuine unrelated third party. That produces a **capital loss** reported on Form 8949, subject to netting and the $3,000 limit. **[V: a sale is a disposition. U: some "worthless token buyer" services may be challenged as shams if there is a side agreement or a related party. Have the CPA review.]**
- **If you qualify for TTS:** a worthless or abandoned position held in the trading business may be deductible as a business loss under §165(c)(1) rather than a miscellaneous itemized deduction. **[U: get professional analysis]**
- **Pending (not law):** H.R. 10357 §306 would add §165(m), treating a worthless digital asset as sold on the last day of the tax year. That would make it a **capital loss** and fix the problem above. **[V text; not enacted]**
- **Documentation for rug pulls:**
    - The token mint address and your wallet addresses.
    - Transaction signatures for buys and the attempted or actual sale.
    - On-chain evidence of liquidity removal (LP pull) or mint-authority abuse.
    - Screenshots from Dexscreener/Birdeye/Solscan showing price and liquidity, dated.
    - Developer or social-media announcements or disappearance.
    - Proof of the sale for nominal value, or of failed sale attempts.
    - Any police, IC3, or state AG complaint, if a theft claim is considered.

### 1.4 Theft and scam losses after TCJA, and what OBBBA changed
- **§165(h)(5)** limits **personal** casualty and theft losses (from transactions that are not business or profit-motivated) to federally declared disasters, or to the extent of personal casualty gains. **OBBBA §70109 made this permanent** and **added "State declared disasters"** for tax years beginning after Dec 31, 2025. **OBBBA did not reopen deductions for personal theft losses.** **[V]**
- **Profit-motivated theft losses are still deductible** under §165(c)(2). **[V: CCA 202511015, March 2025]**
    - Investment scams and pig-butchering schemes where the victim transferred funds *to invest* qualify.
    - Romance and "kidnapping" scams (no profit motive) do **not** qualify.
    - The loss must be a **theft under applicable state law**, is limited to your **basis**, and is taken in the year discovered **when there is no reasonable prospect of recovery**.
    - The Ponzi safe harbor (Rev. Proc. 2009-20) usually does not apply when the perpetrator has not been identified or charged.
- **Reporting:** Form 4684 Section B, then Schedule A as an "other itemized deduction." Losses on income-producing property are not miscellaneous itemized deductions (§67(b)(3)), so they are not barred by §67(g). **[V for §67(b)(3); S/U for the exact form line and NOL interaction. Ask the CPA.]**
- **Rug pull as "theft"?** Possibly, if the developer's conduct is criminal fraud or theft under state law. This turns heavily on the facts and is contested. Do not claim it without strong evidence and professional sign-off. A sale for nominal value (capital loss) is the simpler and safer route. **[U]**

---

## 2. Nevada
- **No personal income tax in Nevada.** **[V: NV Dept. of Taxation, "Income Tax in Nevada"]** No state return is needed for wages or capital gains.
- **Commerce Tax** applies only to business entities with Nevada gross revenue **above $4,000,000**. It is not relevant to a W-2 employee or trader. **[V]**
- If you start a business in Nevada (for example a paid terminal or subscription service), the **Nevada State Business License** and local (county/city) licensing rules may apply. **[U: confirm fee and exemptions with the NV Secretary of State]**
- **Moving states matters:** **[V for the general principle; U for any specific state]**
    - A resident of a state with an income tax is generally taxed there on **all** income, including capital gains realized after becoming a resident. California, for example, taxes capital gains as ordinary income.
    - **Timing:** realize large gains *while a Nevada resident*. If you plan to move to a taxing state, consider realizing losses *after* the move.
    - Whether federal capital loss carryovers carry into the new state's computation depends on that state's rules.
    - High-tax states (notably California) audit claimed residency changes. Keep evidence of domicile: driver's license, voter registration, lease or deed, time spent in each state.

---

## 3. Deductions without a business

### 3.1 Investment expenses: permanently non-deductible for investors [V]
- TCJA §67(g) suspended miscellaneous itemized deductions for 2018–2025. **OBBBA §70110 deleted the 2026 sunset**, so the suspension is **permanent** for tax years beginning after Dec 31, 2025. The only carve-out is a new deduction for educator expenses.
- For a non-TTS investor, the following are **not deductible**: investment advisory fees, subscriptions (charting, Nansen, data feeds), software, trading-tax software, investment publications, home office, computers, internet, phone, and education.
- **Trading fees and commissions** are not separately deductible. They are added to basis or subtracted from proceeds (Topic 429). **[V]**
- **W-2 unreimbursed employee expenses** are also miscellaneous itemized deductions, so they are permanently non-deductible. The narrow exceptions (e.g., Armed Forces reservists, qualified performing artists, fee-basis officials, and the new educator category) are not relevant here. **[V for the §67 suspension; S for the exception list]**

### 3.2 Trader Tax Status (TTS)
- **What it is:** a facts-and-circumstances finding that you are in the *business* of trading. There is no election and no form for TTS itself. Business expenses go on **Schedule C**. Gains and losses stay **capital** (Form 8949/Schedule D) unless a §475 election is in effect. **[V: Topic 429]**
- **IRS criteria** (Topic 429) **[V]**:
  1. You seek profit from **daily market movements**, not dividends, interest, or long-term appreciation.
  2. The activity is **substantial**.
  3. It is carried on with **continuity and regularity**.
    - Factors: typical holding periods; frequency and dollar amount of trades; whether you pursue it for a livelihood; time devoted.
- **Key cases** (citations from long-standing case law; the CPA should pull them) **[S/U]**:
    - *Higgins v. Commissioner*, 312 U.S. 212 (1941): managing your own investments, however large, is not a business.
    - *Commissioner v. Groetzinger*, 480 U.S. 23 (1987): a trade or business requires continuity, regularity, and a profit motive.
    - *Chen v. Commissioner*, T.C. Memo. 2004-132: about 300+ trades, not substantial enough.
    - *Holsinger v. Commissioner*, T.C. Memo. 2008-191: trading sporadically alongside a full-time job did not qualify.
    - *Endicott v. Commissioner*, T.C. Memo. 2013-199: many trades but holding periods over about a month, so not a trader.
    - *Nelson v. Commissioner*, T.C. Memo. 2013-259: trading on only part of the year's days, so not a trader.
    - *Assaderaghi v. Commissioner*, T.C. Memo. 2014-33: TTS denied.
    - *Poppe v. Commissioner*, T.C. Memo. 2015-205: TTS allowed for a full-time trader.
- **Applied to this profile [U]:** high-frequency memecoin trading with very short holds supports "daily market movements." A full-time W-2 job weighs against substantiality and regularity, as in *Holsinger*. Practitioner rules of thumb (not law) include trading on nearly every market day, hundreds or more trades per year, average holds of days rather than weeks, several hours a day, and a meaningful account size.
    - Topic 429 is written for "securities." Whether a crypto-only trading business qualifies for TTS under §162 for *expense* purposes is generally accepted by practitioners but has little direct authority. **[U]**
- **Investment segregation:** to hold some assets as investments alongside a trading business, identify them on the day you buy them, for example by using separate wallets or accounts. **[V: Topic 429]**
- **If TTS applies, possibly deductible on Schedule C:** home office (Pub 587: regular and exclusive use, principal place of business; simplified method of $5/sq ft up to 300 sq ft), the business share of equipment, internet and phone, data feeds, software, and education that maintains or improves skills in the existing trade. Margin or other interest traced to the trading business. **[V for Pub 587 rules; U for the rest given crypto-TTS uncertainty]**

### 3.3 Section 475(f) mark-to-market election
- **Effect** (for securities and, separately, commodities): year-end positions are treated as sold at fair market value. Gains and losses become **ordinary** (Form 4797 Part II). **No $3,000 capital loss limit and no wash-sale rule** (§475(d)(1)). Unused losses can feed an NOL. **[V: Topic 429]**
- **Deadline** **[V: Topic 429; Rev. Proc. 99-17]**:
    - Attach a statement to the **prior year's return, or to the extension request**, by the **original due date (no extensions)**.
    - For **tax year 2027**: by **April 15, 2027**, attached to the 2026 return or Form 4868.
    - **The deadline for tax year 2026 passed on April 15, 2026.**
    - Late elections are generally not allowed.
    - Then file **Form 3115** under **Rev. Proc. 2025-23 §24.01** with the first election-year return.
    - Revoking requires notice by the same type of deadline. Re-electing within 5 years of revoking needs non-automatic consent and a user fee.
- **"New taxpayer" 75-day rule** (2 months 15 days, with the statement placed in your own books): available only to a taxpayer **not required to file a return for the prior year**, typically a newly formed entity. An individual who already files does not qualify. **[V]**
- **Does §475 cover crypto? Under current law, generally not.** **[S/U]**
    - §475(c)(2) securities are stock, debt, certain partnership/trust interests, notional principal contracts, and derivatives on these. Spot crypto is not on the list.
    - §475(e)/(f)(2) commodities: whether spot crypto is an "actively traded" commodity for this purpose has not been resolved. Practitioners (Green Trader Tax; McDermott) generally advise against assuming that a §475 election covers spot crypto.
    - CME bitcoin/ether futures are §1256 contracts (60/40 treatment).
    - H.R. 10357 §202 would add a new §475(g) election for dealers and traders in "covered digital assets." That is **proposed only**. **[V text]**
- **Stock options:** for a securities trader with TTS, §475(f) can cover equity options. Weigh this carefully: §475 ordinary treatment gives up the 60/40 treatment on §1256 index options if a commodities election is also made. **[S/U]**

### 3.4 Section 179 and depreciation (TTS only) [S]
- **Section 179:** $2.5 million limit with phaseout starting at $4 million of qualifying property placed in service (OBBBA, effective for property placed in service in tax years beginning after 2024). Secondary sources report the 2026 indexed amounts as about $2.56 million and $4.09 million. **[S]**
- **Bonus depreciation:** 100% bonus depreciation made permanent for property acquired after **Jan 19, 2025** (OBBBA). **[S, multiple firms]**
- **Smaller items:** the de minimis safe harbor (Treas. Reg. §1.263(a)-1(f), $2,500 per item without an audited financial statement) is usually simpler. **[V regulation; ask the CPA]**
- **Mixed-use items** (a phone, a laptop) need a business-use percentage. Listed-property rules apply when business use is 50% or less.
- Section 179 is limited to business taxable income. Your **W-2 wages count** for this purpose under Treas. Reg. §1.179-2(c)(6)(iv). **[U: verify]**

### 3.5 Credit card interest and investment interest
- **Personal interest is not deductible** (§163(h)). That includes ordinary credit card interest. OBBBA's new car-loan interest deduction (2025–2028) does not apply to credit cards. **[V: §163(h)]**
- **Investment interest (§163(d), Form 4952)** is deductible only if the **borrowed money was used to buy investment property**, such as crypto held for investment. Limits:
    - Only as an **itemized deduction**. It does nothing if you take the standard deduction ($16,100 single in 2026).
    - Only up to **net investment income**. Long-term capital gains and qualified dividends count as investment income **only if you elect** to have them taxed at ordinary rates (Form 4952, line 4g).
    - Disallowed amounts **carry forward indefinitely**. **[V: statute and Pub 550]**
- **Tracing rules (Temp. Treas. Reg. §1.163-8T)** **[V regulation; U for specific facts]**:
    - Interest follows the **use** of the loan proceeds, not what secures the loan.
    - A credit card *purchase* of goods is personal debt.
    - A cash advance or balance transfer deposited into an account and then sent to an exchange or wallet to buy crypto *may* be investment debt.
    - Under the 15-day rule, proceeds spent within 15 days of a deposit can be treated as used for that purpose. Otherwise ordering rules apply. Mixed balances get complicated.
    - Keep a clean paper trail: a separate account, dated transfers, and the matching on-chain purchase.
    - Under TTS, debt traced to the trading business is business interest on Schedule C.
- **Credit card debt settled or forgiven:** generally taxable cancellation-of-debt income (Form 1099-C), unless an exclusion applies, such as insolvency under §108(a)(1)(B) (Form 982). **[V statute]**

---

## 4. Self-employment tax and business-like activities
- **Trading gains are not self-employment income, even with TTS or a §475 election.** **[V: Topic 429; §1402(a)(3)]** They are generally subject to the **3.8% NIIT** (§1411) if MAGI exceeds the thresholds.
- **Ordinary income events in crypto** **[V]**:
    - **Airdrops after a hard fork, and other airdrops:** income equal to FMV when you gain dominion and control (Rev. Rul. 2019-24).
    - **Staking rewards:** income when you gain dominion and control (Rev. Rul. 2023-14). RSM reports a 2026 Tax Court memo, *Paschall v. Commissioner*, T.C. Memo. 2026-46, generally supporting this. **[S]**
    - **Payments for services in crypto, and token-creator fees or rewards** (e.g., pump.fun creator fees): ordinary income. **[V for compensation; U for creator-fee specifics]**
    - The FMV included in income becomes your basis in those tokens.
- **When it becomes a business (Schedule C, SE tax of 15.3% up to the Social Security wage base, then 2.9%)** **[V: general rules; U: application]**:
    - Running a **paid terminal, subscription, signals, or analytics service** is a business. Net profit is subject to SE tax. Expenses become deductible, and Nevada licensing may apply.
    - **Systematic airdrop farming, validator operation, or regular token launches** may be a trade or business. Then income is SE income and expenses are deductible.
    - Note that your W-2 wages already count toward the Social Security wage base, which reduces the 12.4% portion of SE tax.
- **Hobby loss rules (§183):**
    - Profit is presumed if the activity shows a profit in **3 of 5 years**.
    - Factors are listed in Treas. Reg. §1.183-2(b).
    - Hobby **income is taxable**, but hobby **expenses are not deductible** because of the permanent §67(g) suspension. **[V]**
    - A loss-making "trading business" with a W-2 job and no profit history invites §183 scrutiny of the TTS claim.
- **Information returns:** **[S/V]**
    - OBBBA restored the Form 1099-K threshold to more than **$20,000 and more than 200 transactions** for third-party network payments. **[V: IRS FAQ]**
    - Form 1099-NEC/MISC threshold rises to **$2,000** for payments in 2026, then is indexed from 2027. **[S]**
    - Income is taxable whether or not a form is issued.

---

## 5. Law changes for 2025–2026

### 5.1 Broker reporting and basis
- **Form 1099-DA** **[V: Form 1099-DA instructions 2025 and 2026]**:
    - **2025 sales:** custodial brokers report **gross proceeds**. Basis reporting was optional.
    - **2026 sales:** gross proceeds are required, and **basis is required for "covered securities"** (generally digital assets acquired in that same broker account on or after Jan 1, 2026). Noncovered lots may show no basis, and you must supply basis yourself.
    - Notice 2024-56 gave good-faith penalty relief to brokers for 2025.
    - Backup-withholding relief was extended through 2026 (Notice 2025-33), with limited relief for 2027. **[S: EY]**
    - Stablecoin and NFT de minimis rules exist; see the instructions.
- **DeFi broker rule repealed:** H.J.Res. 25, signed **April 10, 2025** as **Public Law 119-5**, disapproved the IRS "DeFi broker" rule (T.D. 10021) under the Congressional Review Act. **[V]** **Non-custodial DEXs (Jupiter, Raydium, pump.fun, and others) will not send 1099-DAs. All DEX trades must still be self-reported.**
- **Wallet-by-wallet (account-by-account) basis from Jan 1, 2025** (Treas. Reg. §1.1012-1(j)) **[V]**:
    - Basis must be tracked per wallet or account. Universal (pooled) tracking ended Dec 31, 2024.
    - **Rev. Proc. 2024-28 safe harbor** for allocating unused basis as of Jan 1, 2025:
    - A **global allocation** method had to be **written in your books and records before Jan 1, 2025**.
    - A **specific-unit allocation** must be completed before the **earlier of** (a) the first 2025 sale, disposition, or transfer of that asset type or (b) the 2025 return due date, including extensions. For extended 2025 returns that is **Oct 15, 2026**.
    - For an active trader who traded in early 2025, this window has likely closed. The CPA should confirm what method was or can be used.
    - **Notice 2025-7:** in 2025 only, allowed identification of units held with brokers through your own books or standing orders. It expired after Dec 31, 2025. Without adequate identification, **FIFO** is the default for each wallet or account. **[S/V]**

### 5.2 OBBBA (P.L. 119-21, signed July 4, 2025) and 2026 figures
- **Brackets made permanent**, top rate 37%. **2026 single brackets** (Rev. Proc. 2025-32) **[V]**:

| Rate | Taxable income (single) | MFJ upper end of bracket |
|---|---|---|
| 10% | up to $12,400 | $24,800 |
| 12% | $12,400 – $50,400 | $100,800 |
| 22% | $50,400 – $105,700 | $211,400 |
| 24% | $105,700 – $201,775 | $403,550 |
| 32% | $201,775 – $256,225 | $512,450 |
| 35% | $256,225 – $640,600 | $768,700 |
| 37% | above $640,600 | above $768,700 |

- **Standard deduction:** 2025 $15,750 single / $31,500 MFJ / $23,625 HOH. 2026 **$16,100** single and MFS / **$32,200** MFJ / **$24,150** HOH. **[V]**
- **2026 long-term capital gains and qualified dividend rates (taxable-income thresholds)** **[V: Rev. Proc. 2025-32 §4.03]**:

| Filing status | 0% up to | 15% up to | 20% above |
|---|---|---|---|
| Single | $49,450 | $545,500 | $545,500 |
| MFJ | $98,900 | $613,700 | $613,700 |
| MFS | $49,450 | $306,850 | $306,850 |
| HOH | $66,200 | $579,600 | $579,600 |

Short-term gains are taxed at ordinary rates. The 28% collectibles rate applies to collectibles; IRS has not issued general guidance treating fungible tokens as collectibles. Ask the CPA about NFTs. **[U]**

- **NIIT** of 3.8% on the lesser of net investment income or MAGI above **$200,000 (single/HOH) / $250,000 (MFJ) / $125,000 (MFS)**. Not indexed. **[V]**
- **SALT cap:** **$40,000 for 2025**, **$40,400 for 2026** ($20,200 MFS), rising 1% a year through 2029. The cap phases down by 30% of MAGI over **$505,000 (2026)**, but not below $10,000. It reverts to **$10,000 in 2030**. **[S: multiple sources]** For a Nevada resident with no state income tax this mostly matters only for property and sales tax, and only if itemizing.
- **Miscellaneous itemized deductions permanently suspended** (§70110). Personal casualty-loss limit permanent, with state-declared disasters added (§70109). **[V]**
- **Charitable giving (2026+):** non-itemizer deduction of $1,000 single / $2,000 MFJ for cash gifts, and a 0.5%-of-AGI floor for itemizers. **[S]** Donating appreciated crypto held more than one year can give a fair-market-value deduction, but **crypto gifts over $5,000 need a qualified appraisal** (CCA 202302012). **[V/S]**
- **Digital-asset question on Form 1040** **[V: 2025 instructions]**:
    - Answer **Yes** if you received digital assets (as a reward, an award, payment, mining, staking, or a fork) or sold, exchanged, or otherwise disposed of them.
    - Answer **No** only if you merely held them, moved them between your own wallets, or bought them with USD.
    - The box must be checked either way. An active trader answers **Yes**.

---

## 6. Records to keep going forward (checklist)
- [ ] **List of every wallet and account**: Solana public keys, exchange accounts, hardware wallets. Mark each as "investment" or "trading" on the day it is opened.
- [ ] **Full transaction export for each wallet**: Solscan, Helius, or an indexer CSV, plus a crypto-tax tool. Keep the **transaction signature**, timestamp (stored in UTC, reported in your time zone), token mint, quantity, USD fair market value at the time, fees (base and priority fees, Jito tips), and counterparty program (Jupiter, Raydium, pump.fun).
- [ ] **Per-wallet lot records** with the identification method (specific ID or FIFO) recorded before each sale. Keep your Rev. Proc. 2024-28 allocation memo.
- [ ] **Exchange records**: Forms 1099-DA/1099-B/1099-K, monthly statements, and the exchange's CSVs. Reconcile them against your own records. Note any noncovered lots where the 1099-DA shows no basis.
- [ ] **Income events**: airdrops, staking, rewards, creator fees, referral or bounty payments. Record date of receipt and FMV, which becomes your basis.
- [ ] **Rug pull and worthlessness file** for each token (see §1.3), plus proof of any nominal-value sale.
- [ ] **Theft or scam file**: communications, URLs, wallet addresses, police/IC3/FTC reports, recovery attempts, and the date you concluded there was no reasonable prospect of recovery.
- [ ] **Stock and options**: broker 1099-B with wash-sale adjustments. Watch for wash sales across accounts and IRAs.
- [ ] **If pursuing TTS**: a **daily time log**; counts of trades and trading days; holding-period statistics; a written trading plan; a separate trading account and bank account; invoices for expenses; home office square footage and photos; business-use percentages for equipment.
- [ ] **§475 election**: a copy of the statement attached to the prior-year return or Form 4868, proof of timely filing, and Form 3115.
- [ ] **Loan tracing**: statements showing any borrowed money (credit card cash advances, personal loans) going into the exchange or wallet, kept separate from personal spending.
- [ ] **Nevada residency evidence**: driver's license, voter registration, lease or deed, utility bills, and a day-count log if you travel or own property elsewhere.
- [ ] **Estimated tax payments** (Form 1040-ES) or increased W-4 withholding in big-gain years. The prior-year safe harbor is 100% of last year's tax, or 110% if prior-year AGI was over $150k (§6654). **[V statute]**
- [ ] Keep records **at least 3 years after filing**. Keep them longer (6+ years) where income may be underreported by more than 25%, and **for as long as you hold a lot plus 3 years** for basis records. The carryforward computation needs records from the year each loss arose.

---

## 7. Red flags and strategies to avoid
1. **Unreported DEX trades.** No 1099-DA does not mean no tax. Each swap is a taxable disposition. Under-reporting can lead to the accuracy-related penalty (20%, §6662) and, in egregious cases, the civil fraud penalty (75%, §6663). **[V statute]** Do not answer "No" to the digital-asset question as an active trader.
2. **Ignoring airdrop, staking, or creator income.** It is ordinary income at FMV when received (Rev. Rul. 2019-24, 2023-14), even if the token later falls to zero. The later decline is a separate capital loss only when you sell.
3. **Claiming a home office or equipment without TTS.** These are not deductible for investors, and the miscellaneous itemized deduction suspension is now permanent. A Schedule C with losses and no income alongside a W-2 is a known audit trigger. **[U as to audit selection]**
4. **Sham wash trades**: self-trades between your own wallets, related-party "sales" (§267), prearranged buybacks, or "worthless token buyer" deals with side agreements. Also consider the **retroactive-risk window under H.R. 10357** for dispositions after Sept 14, 2026.
5. **Offshore exchanges, FBAR and FATCA:**
    - FinCEN Notice 2020-2: a foreign account holding **only** virtual currency is currently **not** reportable on the FBAR (FinCEN 114). FinCEN has said it intends to change this. If the foreign account also holds fiat or other reportable assets, the FBAR applies once aggregate foreign accounts exceed $10,000 at any time in the year. **[V: FinCEN notice]**
    - **Form 8938 (FATCA)** treatment of foreign-held crypto is **not definitively resolved**. Many practitioners file protectively above the thresholds. **[U]**
    - Using offshore or VPN-accessed exchanges also brings terms-of-service and legal issues, and taxable gains must be reported regardless.
6. **Aggressive theft-loss claims**: claiming a §165 theft loss for ordinary market losses, rug pulls without evidence of criminal theft, or romance-type scams (not deductible) invites an audit. You need the state-law theft elements, a profit motive, the right year, and the right basis.
7. **Missing the §475(f) deadline**: there is no late election, and the 2026 window is closed. Decide **before April 15, 2027** for 2027. Remember §475 likely does not cover spot crypto, and an election converts future capital gains into ordinary income, which also affects the NIIT and SE analysis.
8. **Debt-funded trading**: credit card interest is personal unless traced to an investment purchase. Even then it needs itemizing and enough net investment income. Trading losses do not cancel credit card debt, and settled debt can create taxable income. A financial-risk note, not a tax point: 20%+ card APRs against speculative memecoin positions compounds losses.
9. **Assuming capital losses wipe out W-2 income.** Only **$3,000 a year** offsets ordinary income. Large losses mainly shelter *future capital gains*. Track the carryforward carefully.
10. **Ignoring estimated tax payments** in a year with large realized gains, which leads to the §6654 underpayment penalty.

---

## 8. Open questions for the tax professional
1. Should 2026 harvest-and-rebuy trades made after Sept 14, 2026 be unwound or avoided given H.R. 10357's effective date? Monitor the bill's status after the midterms.
2. What is the best path for each rug-pulled token: a nominal-value sale (capital loss), abandonment (no deduction for an investor), or a theft claim?
3. Is TTS realistic alongside a full-time W-2 job, and what volume, time, and record-keeping would support it? Can a crypto-only trading business support TTS for expenses?
4. Should a §475(f) securities election be made for **2027** (by Apr 15, 2027) for the stock and options activity only, and how would it interact with §1256 index options and with crypto (which is likely outside §475 today)?
5. What basis allocation method was used for the Jan 1, 2025 wallet-by-wallet transition under Rev. Proc. 2024-28, and is anything still needed before the Oct 15, 2026 extended due date, if applicable?
6. Can any credit-card-funded crypto purchases be traced, and is itemizing worthwhile?
7. Is Form 8938 needed for any offshore-held crypto, and does any foreign account hold fiat (which would trigger the FBAR)?
8. What are the required estimated payments or W-4 changes for 2026 and 2027?

---

## Sources (accessed Oct 11, 2026)
**Primary: IRS / Treasury**
- IRS Topic 429, Traders in Securities: https://www.irs.gov/taxtopics/tc429
- IRS Topic 559, Net Investment Income Tax: https://www.irs.gov/taxtopics/tc559
- IRS newsroom, 2026 inflation adjustments incl. OBBB: https://www.irs.gov/newsroom/irs-releases-tax-inflation-adjustments-for-tax-year-2026-including-amendments-from-the-one-big-beautiful-bill
- Rev. Proc. 2025-32 (2026 inflation adjustments): https://www.irs.gov/pub/irs-drop/rp-25-32.pdf
- Pub 550, Investment Income and Expenses: https://www.irs.gov/publications/p550
- Pub 544, Sales and Other Dispositions of Assets: https://www.irs.gov/publications/p544
- Pub 587, Business Use of Your Home: https://www.irs.gov/publications/p587
- Notice 2014-21: https://www.irs.gov/pub/irs-drop/n-14-21.pdf
- Rev. Rul. 2019-24: https://www.irs.gov/pub/irs-drop/rr-19-24.pdf
- Rev. Rul. 2023-14: https://www.irs.gov/pub/irs-drop/rr-23-14.pdf
- IRS Digital Assets page and FAQs: https://www.irs.gov/filing/digital-assets
- Form 8949 and instructions (2025): https://www.irs.gov/pub/irs-pdf/f8949.pdf ; https://www.irs.gov/pub/irs-pdf/i8949.pdf
- Schedule D instructions: https://www.irs.gov/pub/irs-pdf/i1040sd.pdf
- Form 1099-DA instructions (2025): https://www.irs.gov/pub/irs-prior/i1099da--2025.pdf ; (2026): https://www.irs.gov/instructions/i1099da
- Notice 2024-56: https://www.irs.gov/pub/irs-drop/n-24-56.pdf
- Notice 2025-7: https://www.irs.gov/pub/irs-drop/n-25-07.pdf
- Rev. Proc. 2024-28: https://www.irs.gov/pub/irs-drop/rp-24-28.pdf
- Rev. Proc. 99-17 (§475(f) elections): https://www.irs.gov/pub/irs-drop/rp-99-17.pdf
- CCA 202302011 (worthless/abandoned crypto): https://www.irs.gov/pub/irs-wd/202302011.pdf
- CCA 202511015 (scam theft losses): https://www.irs.gov/pub/irs-wd/202511015.pdf
- IRS FAQ on Form 1099-K threshold under OBBB: https://www.irs.gov/newsroom/irs-issues-faqs-on-form-1099-k-threshold-under-the-one-big-beautiful-bill-dollar-limit-reverts-to-20000
- Form 1040 (2025): https://www.irs.gov/pub/irs-prior/f1040--2025.pdf
- FinCEN Notice 2020-2 (virtual currency and FBAR): https://fincen.gov/sites/default/files/shared/Notice-Virtual%20Currency%20Reporting%20on%20the%20FBAR%20123020.pdf

**Primary: Congress / statute**
- OBBBA, P.L. 119-21, §70110 text: https://onebigbeautifulbill.us/obbba-text/title-vii/sec-70110-termination-of-miscellaneous-itemized-deductions-other-than-educator-expenses/ (unofficial mirror of the enacted text; official text is at congress.gov, H.R. 1, 119th Congress)
- OBBBA §67 changes annotated (Prof. A. Nellen, SJSU): https://www.sjsu.edu/people/annette.nellen/67_OBBB_Changes.pdf
- H.J.Res. 25 / P.L. 119-5 (DeFi broker rule CRA): https://www.congress.gov/bill/119th-congress/house-joint-resolution/25 ; https://www.govinfo.gov/app/details/PLAW-119publ5
- H.R. 10357, Digital Asset Tax Certainty Act (introduced text): https://www.congress.gov/119/bills/hr10357/BILLS-119hr10357ih.htm
- JCX-50-26, description of the chairman's substitute (effective date Sept 14, 2026): https://waysandmeans.house.gov/wp-content/uploads/2026/09/JCT-Description-of-AINS-to-HR-10357.pdf
- H.R. 9172 (wash-sale/constructive sale, introduced June 8, 2026): https://www.congress.gov/119/bills/hr9172/BILLS-119hr9172ih.htm
- 26 U.S.C. §§67, 163, 164, 165, 183, 267, 475, 1091, 1211, 1212, 1256, 1402, 1411, 6654, 7701(o): https://uscode.house.gov/

**Nevada**
- Income Tax in Nevada: https://tax.nv.gov/about-nevada-department-of-taxation/income-tax-in-nevada/
- Commerce Tax FAQs: https://tax.nv.gov/faqs/commerce-tax-faqs/

**Secondary (CPA / law firm / professional)**
- RSM, "Digital asset tax reform bill advances..." (Sept 30, 2026): https://rsmus.com/insights/tax-alerts/2026/digital-asset-tax-reform-business-implications.html
- AICPA, Rev. Proc. 2024-28 FAQs: https://www.aicpa-cima.com/resources/article/digital-asset-safe-harbor-rev-proc-2024-28-faqs
- Journal of Accountancy on CCA 202302011: https://www.journalofaccountancy.com/issues/2023/oct/no-loss-deduction-from-drastic-drop-in-digital-assets-value/
- Journal of Accountancy on CCA 202511015: https://www.journalofaccountancy.com/issues/2025/jul/deductibility-of-theft-losses-for-victims-of-certain-scams/
- McDermott, crypto loss memo: https://www.mcdermottlaw.com/insights/irs-releases-memorandum-on-deducting-cryptocurrency-losses/
- EY, broker reporting and backup withholding relief: https://taxnews.ey.com/news/2025-1267-irs-extends-transitional-relief-from-broker-reporting-and-withholding-on-digital-assets
- Green Trader Tax, crypto and §475: https://greentradertax.com/cryptocurrencies-trader-tax-status-and-section-475-issues/
- BDO, OBBBA depreciation: https://www.bdo.com/insights/tax/one-big-beautiful-bill-act-expands-100-depreciation-expensing-opportunities
- GBQ, OBBBA depreciation 2026 (indexed §179 figures): https://www.gbq.com/resources/article/obbba-depreciation-one-year-later
- RSM, OBBBA information-reporting changes: https://rsmus.com/insights/tax-alerts/2025/tips-navigating-obbba-new-changes-us-tax-reporting-withholding-rules.html

*No figures in this memo were estimated. Where a number comes only from a secondary source it is marked [S]. Case citations are from long-standing case law and should be pulled and confirmed by the professional.*

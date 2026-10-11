#!/usr/bin/env python3
"""Expansion categories A-J and self-generated rules 43+ -> data/patternlab_ext_aj.json, data/patternlab_ext_gen.json.
Tape rules use the age-matched early-life window (first 300 Nansen-indexed DEX trades, cached; no new spend). Static DB/contract
rules use flag_t = created_t. Both directions scored (extcommon.stats2)."""
import os, sys, json, math, collections, re, time, statistics as st
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import extcommon as E, tapes as T
from extcommon import stats2, row

FULL = E.full(); CORE = E.core50()
CTAPE = {t['mint']: T.early(T.tape(t), 300) for t in CORE}

def tape_rule(fn):
    """fn(t, trades) -> flag_t or None. Untestable when <30 indexed trades."""
    rows = []
    for t in CORE:
        tr = CTAPE.get(t['mint']) or []
        if len(tr) < 30: rows.append({**E.base(t), 'testable': False}); continue
        ft = fn(t, tr)
        rows.append({**E.base(t), 'flag': ft is not None, 'flag_t': ft, 'testable': True, 'created_t': t.get('created_t')})
    out = stats2(rows)
    em = stats2([r for r in rows if (r.get('created_t') or 0) >= ERA])
    out['era_matched'] = {k: em[k] for k in ('n_crashed', 'n_runners', 'flag_crashed', 'flag_runners', 'p_fisher', 'verdict')}
    return out
ERA = 1789000000  # 2026-09-09: era-matched robustness subset (crashed core is dominated by one Oct-10 launch batch)

def static_rule(fn, pop=None):
    rows = []
    for t in (pop or FULL):
        v = fn(t)
        if v is None: rows.append({**E.base(t), 'testable': False}); continue
        rows.append({**E.base(t), 'flag': bool(v), 'flag_t': t.get('created_t'), 'testable': True})
    return stats2(rows)

def both_static(fn):
    core = {t['mint'] for t in CORE}
    return static_rule(fn, CORE), static_rule(fn, FULL)

usd = lambda r: r.get('estimated_value_usd') or 0
sol = lambda r: r.get('traded_token_amount') or 0
buy = lambda r: r.get('action') == 'BUY'
lab = lambda r: r.get('trader_address_label') or ''

# ---------- tape feature functions ----------
def f_sybil(t, tr):  # A1
    b = [r for r in tr if buy(r) and sol(r) > 0]
    for i, r in enumerate(b):
        w = [x for x in b[i:i + 40] if x['ts'] - r['ts'] <= 2]
        grp = {x['trader_address'] for x in w if abs(sol(x) / sol(r) - 1) <= 0.05}
        if len(grp) >= 5: return w[-1]['ts']
    return None

def _round(a): return abs(a * 20 - round(a * 20)) < 1e-6  # multiples of 0.05 SOL = human round numbers
def f_fingerprint(t, tr):  # E1
    seen = collections.defaultdict(set)
    for r in tr:
        a = sol(r)
        if not buy(r) or a <= 0 or _round(a): continue
        k = float('%.4g' % a); seen[k].add(r['trader_address'])
        if len(seen[k]) >= 3: return r['ts']
    return None

def f_block_sell(t, tr):  # F1
    cum = 0
    for i, r in enumerate(tr):
        if i >= 20 and not buy(r) and usd(r) >= 500 and usd(r) >= 0.10 * cum: return r['ts']
        cum += usd(r)
    return None

def f_sandwich(t, tr):  # H1
    n = 0
    for i, r in enumerate(tr):
        if not buy(r): continue
        for j in range(i + 2, min(i + 8, len(tr))):
            x = tr[j]
            if x['ts'] - r['ts'] > 2: break
            if x['trader_address'] == r['trader_address'] and not buy(x) and any(y['trader_address'] != r['trader_address'] for y in tr[i + 1:j]):
                n += 1
                if n >= 3: return x['ts']
                break
    return None

def f_dev_sell(t, tr):  # 43
    sym = (t.get('symbol') or '').strip().lower(); dev = t['db'].get('dev')
    for r in tr:
        L = lab(r).lower()
        if not buy(r) and (r['trader_address'] == dev or (sym and 'deployer' in L and L.startswith(sym))): return r['ts']
    return None

def f_snipe(t, tr):  # 44
    t0 = tr[0]['ts']; tot = sum(usd(r) for r in tr if buy(r)) or 1
    s = sum(usd(r) for r in tr if buy(r) and r['ts'] - t0 <= 5)
    return t0 + 5 if s / tot >= 0.20 else None

def f_flip(t, tr):  # 45
    first = {}; flips = set()
    for r in tr:
        w = r['trader_address']
        if buy(r) and w not in first: first[w] = r['ts']
        elif not buy(r) and w in first and r['ts'] - first[w] <= 600: flips.add(w)
    ws = list(first)[:100]
    if len(ws) < 30: return None
    share = sum(1 for w in ws if w in flips) / len(ws)
    return first[ws[-1]] + 600 if share >= 0.40 else None

def f_conc(t, tr):  # 46
    v = collections.Counter()
    for r in tr:
        if buy(r): v[r['trader_address']] += usd(r)
    tot = sum(v.values()) or 1
    return tr[-1]['ts'] if sum(x for _, x in v.most_common(5)) / tot >= 0.5 else None

def f_sm(t, tr):  # 47
    ws = set()
    for r in tr:
        if T.is_sm(lab(r)): ws.add(r['trader_address'])
        if len(ws) >= 2: return r['ts']
    return None

def f_sell_ramp(t, tr):  # 48
    q = len(tr) // 4
    if q < 10: return None
    s1 = sum(1 for r in tr[:q] if not buy(r)) / q; s4 = sum(1 for r in tr[-q:] if not buy(r)) / q
    return tr[-1]['ts'] if s4 >= 0.55 and s4 >= s1 + 0.15 else None

def f_wash(t, tr):  # 49
    nb = collections.Counter(); ns = collections.Counter(); v = collections.Counter()
    for r in tr:
        (nb if buy(r) else ns)[r['trader_address']] += 1; v[r['trader_address']] += usd(r)
    tot = sum(v.values()) or 1
    w = [a for a in v if nb[a] >= 3 and ns[a] >= 3]
    return tr[-1]['ts'] if sum(v[a] for a in w) / tot >= 0.20 else None

def f_bots(t, tr):  # 50
    n = sum(1 for r in tr if '\U0001f916' in lab(r) or 'bot' in lab(r).lower())
    return tr[-1]['ts'] if n / len(tr) >= 0.5 else None

def f_serial(t, tr):  # 51
    sym = (t.get('symbol') or '').strip().lower(); ws = set()
    for r in tr:
        L = lab(r).lower()
        if 'token deployer' in L and not (sym and L.startswith(sym)): ws.add(r['trader_address'])
        if len(ws) >= 3: return r['ts']
    return None

def f_velocity(t, tr):  # 52
    t0 = tr[0]['ts']; ws = set()
    for r in tr:
        if r['ts'] - t0 > 1800: break
        ws.add(r['trader_address'])
        if len(ws) >= 150: return r['ts']
    return None

def f_bigbuys(t, tr):  # 53
    b = [usd(r) for r in tr if buy(r)]
    return tr[-1]['ts'] if b and st.median(b) >= 50 else None

def f_mayhem(t, tr):  # 58
    n = sum(1 for r in tr if 'mayhem' in lab(r).lower())
    return tr[-1]['ts'] if n >= 10 else None

def f_slow(t, tr):  # 59: trade-count decay second 10 min vs first 10 min
    t0 = tr[0]['ts']; a = sum(1 for r in tr if r['ts'] - t0 < 600); b = sum(1 for r in tr if 600 <= r['ts'] - t0 < 1200)
    if a < 20: return None
    return t0 + 1200 if b < 0.3 * a and tr[-1]['ts'] - t0 >= 1200 else None

# ---------- static (DB / contractscan) ----------
CS = {}
for v in ((E.jload('contractscan.json') or {}).get('tokens') or {}).values():
    CS[(v.get('address') or '').lower()] = v
ADMIN = {'mint', 'freeze', 'tfee', 'hook', 'owner', 'proxy', 'proxy_eoa', 'hidden_owner', 'switches', 'balance_edit', 'selfdestruct', 'unverified', 'honeypot', 'tax', 'hidden_tax', 'creator', 'sim_sell', 'holder_fails'}
def cs_flags(t):
    v = CS.get(t['mint'].lower())
    if not v or not v.get('scannable', True): return None
    return {(f.get('id') if isinstance(f, dict) else f) for f in v.get('flags', [])}
def d_admin(t):
    f = cs_flags(t); return None if f is None else bool(f & ADMIN)
def d_mutable(t):
    f = cs_flags(t); return None if f is None else ('mutable' in f)
def d_auth(t):
    d = t['db']
    if d.get('mint_auth') is None and d.get('freeze_auth') is None: return None
    return bool(d.get('mint_auth')) or bool(d.get('freeze_auth'))

def _at1h(t, keys):
    d = t['db']; has = sum(d.get(k) or 0 for k in keys)
    pd = d.get('profile_delay_h')
    if has and pd is not None and pd > 1: return 0
    return has
soc1h = lambda t: _at1h(t, ('has_twitter', 'has_telegram', 'has_website'))
web1h = lambda t: _at1h(t, ('has_website',))

def theme_crowding():  # G1
    import sqlite3
    db = sqlite3.connect(f'file:{E.P.DB}?mode=ro', uri=True)
    allt = [(r[0], r[1] // 1000) for r in db.execute("select theme, created_ts from tokens where theme is not null and theme != '' and created_ts is not null")]
    by = collections.defaultdict(list)
    for th, ts in allt: by[th].append(ts)
    def n_prior(t):
        th = t['db'].get('theme'); ct = t.get('created_t')
        if not th or not ct or th in ('other', 'none', 'unknown'): return None
        return sum(1 for x in by[th] if ct - 86400 <= x < ct)
    return lambda t: (None if n_prior(t) is None else n_prior(t) >= 3)

def wrap_counts(dn, df, mn, mf):
    p2, pg = E.fisher(df, dn - df, mf, mn - mf); _, pl = E.fisher(mf, mn - mf, df, dn - df)
    return {'n_crashed': dn, 'n_runners': mn, 'flag_crashed': df, 'flag_runners': mf, 'hit_crashed': round(df / dn, 3), 'hit_runners': round(mf / mn, 3),
            'p_fisher': round(p2, 4), 'p_crash_one_sided': round(pg, 4), 'p_pump_one_sided': round(pl, 4),
            'crash': {'hit_rate': round(df / dn, 3), 'false_flag_rate': round(mf / mn, 3), 'p_one_sided': round(pg, 4), 'lead_h_median': None},
            'pump': {'hit_rate': round(mf / mn, 3), 'false_flag_rate': round(df / dn, 3), 'p_one_sided': round(pl, 4), 'lead_h_median': None},
            'separates': ('crash' if df / dn > mf / mn else 'pump') if p2 < 0.05 else 'no',
            'verdict': 'crash-predictive (p<0.05)' if pg < 0.05 else 'pump-predictive (p<0.05)' if pl < 0.05 else 'no separation'}

def live_feed():
    return (E.jload('live_feed.json') or {}).get('items') or []

def put_call():
    rows = (E.jload('derive_snapshot.json') or {}).get('rows') or []
    agg = collections.defaultdict(lambda: {'P': 0.0, 'C': 0.0, 'Pv': 0.0, 'Cv': 0.0})
    for r in rows:
        if r.get('cp') in ('P', 'C'):
            a = agg[r.get('cur')]; a[r['cp']] += r.get('oi') or 0; a[r['cp'] + 'v'] += r.get('vol24usd') or 0
    out = []
    for cur, a in agg.items():
        if a['C'] > 0:
            pc = a['P'] / a['C']
            item = {'symbol': cur, 'put_call_oi': round(pc, 2), 'put_call_vol24': round(a['Pv'] / a['Cv'], 2) if a['Cv'] else None}
            if pc >= 1.2 or pc <= 0.4: item['why'] = ('put-heavy (hedging / bearish)' if pc >= 1.2 else 'call-heavy (speculative / crowded long)') + f' P/C OI {pc:.2f} on Derive'; out.append(item)
    return out

if __name__ == '__main__':
    AJ = []; G = []
    LF = live_feed()
    # ----- A -----
    AJ.append(row('A1', 'Sybil buy bundle (>=5 wallets, same size +-5%, within 2 s)', 'built', 'cached Nansen launch tapes, first 300 indexed trades',
                  'Many different wallets buying almost exactly the same amount within two seconds is one operator spreading a buy over sybil wallets (bundled launch or incentive farming). They usually exit together.',
                  core=tape_rule(f_sybil)))
    ad = E.jload('airdrop_desk.json') or {}
    AJ.append(row('A2', 'Airdrop / points farming then dump', 'wrapped', 'wraps lib/airdrops.js (Airdrop Desk: farms, dilution, value estimates). Not testable on the 50-token set: pump.fun memecoins have no airdrop/points program. Proposal: Nansen tgm/who-bought-sold on claim day for airdropped majors (1 credit/token) to measure claimer dump share.',
                  'Wallets that farmed points/airdrops tend to sell on claim; a high share of claimers selling in the first days predicts weak price.', wraps=['airdrops'],
                  live=[{'symbol': c.get('symbol') or c.get('name'), 'why': 'airdrop candidate (Airdrop Desk)'} for c in (ad.get('candidates') or [])[:10] if isinstance(c, dict)]))
    # ----- B -----
    gov = ((E.jload('socialalt.json') or {}).get('governance') or {}).get('hotTopics') or []
    AJ.append(row('B1', 'Governance: whale votes / Snapshot / delegation changes', 'wrapped', 'wraps lib/socialalt.js governance-forum feed (Discourse hot topics: emissions, treasury, unlock votes). Snapshot vote-level whale share and delegation changes need per-DAO token mapping; memecoins in the test set have no governance, so no backtest (not-feasible on test set).',
                  'Big holders voting for emissions/treasury moves or re-delegating right before a vote often precede sell pressure. Flags hot governance threads about issuance/treasury/unlocks.', wraps=['socialalt'],
                  live=[{'symbol': g.get('forum'), 'why': f"{g.get('title', '')[:90]} ({g.get('posts')} posts)"} for g in gov if re.search(r'emission|issuance|treasury|unlock|inflation|burn|buyback|vesting', g.get('title', ''), re.I)][:15]))
    # ----- C -----
    AJ.append(row('C1', 'Staking flows: large unstakes / LST & restaking outflows before dumps', 'not-feasible', 'test-set memecoins have no staking; for majors the free data (validator/LST contract events) needs per-protocol indexers. Nansen could cover it (tgm/flows on LST tokens, ~1-5 credits/token) but there is no labelled staking-dump event set to backtest on, so it stays a proposal (est. 40-100 credits for 20 majors x 2 windows).',
                  'Large holders unstaking (with an unbonding delay) signals intention to sell when the coins unlock.'))
    # ----- D -----
    c1, f1 = both_static(d_admin)
    AJ.append(row('D1', 'Contract admin powers (mint/freeze/fee/hook/owner/proxy/hidden owner/selfdestruct/unverified)', 'wrapped',
                  'wraps lib/contractscan.js (EVM: proxy, owner, hidden owner, fee switches, selfdestruct, unverified bytecode, honeypot sim; Solana: mint/freeze authority, Token-2022 transfer fee/hook). Static snapshot (flag_t = creation). Proxy-upgrade / timelock / owner-change EVENTS over time need event logs per contract: not in scope of the free scan (proposal).',
                  'If the team can still mint, freeze, change fees, swap the contract implementation or hides an owner, they can rug at will. Checked on every test token the scanner covers.', core=c1, full=f1, wraps=['contractscan']))
    c2, f2 = both_static(d_mutable)
    AJ.append(row('D2', 'Mutable metadata (update authority kept)', 'wrapped', 'contractscan Solana metadata check', 'The deployer can still change the token\'s name/logo/links: weak sign of control.', core=c2, full=f2, wraps=['contractscan']))
    c3, f3 = both_static(d_auth)
    AJ.append(row('D3', 'Mint or freeze authority not revoked (research DB)', 'built', 'research DB mint_auth/freeze_auth', 'Unrevoked mint/freeze authority lets the team print tokens or freeze holders.', core=c3, full=f3))
    AJ.append(row('D4', 'Compiler-version anomalies / CREATE2-vanity deployers', 'not-feasible', 'test set is pump.fun SPL tokens: one shared audited program, no per-token compiler or CREATE2. For EVM tokens contractscan already exposes unverified/proxy; compiler-version + vanity checks need verified source metadata from explorers (Etherscan key) — proposal.', 'Odd compiler versions or vanity CREATE2 addresses are sometimes used to dress up or redeploy rug templates.'))
    # ----- E -----
    AJ.append(row('E1', 'Behavioural fingerprint: same odd buy size reused by >=3 wallets', 'built', 'cached Nansen launch tapes. KYC-linked clustering is NOT possible from public data; this is behavioural fingerprinting from on-chain amount habits (non-round SOL sizes to 4 significant digits) and timing.',
                  'Bots and multi-wallet operators reuse the same unusual buy size (e.g. 0.4137 SOL). Three or more wallets sharing it are probably one entity.', core=tape_rule(f_fingerprint)))
    AJ.append(row('E2', 'Funding-source clustering (first funder / related wallets)', 'wrapped', 'covered by Pattern Lab #33 (first-buyer RPC age + funder) and #36 (same deployer bundle creates) and patterns detector 2 (fresh-wallet clusters, research/patterns_wallets.py) — not duplicated. Cross-chain clustering by funding source needs bridge-tx resolution (patterns detector 5 has it for Relay).',
                  'Wallets funded by the same source within minutes, then buying the same token, are one actor.', wraps=['patterns#2', 'patternlab#33', 'patternlab#36', 'bridges']))
    # ----- F -----
    AJ.append(row('F1', 'Block trade: single sell >= 10% of cumulative volume', 'built', 'cached Nansen launch tapes', 'One sell that is a large slice of all volume so far is an insider/whale distribution print.', core=tape_rule(f_block_sell)))
    pn = E.jload('patterns_nansen.json') or {}
    if pn.get('any_to_cex_before_peak'):
        a = pn['any_to_cex_before_peak']
        AJ.append(row('F2', 'CEX deposit flows before the peak (dev/top holders → CEX)', 'wrapped', 'wraps patterns detector 3 (research/patterns_nansen.py: Nansen tgm/transfers include_cex + deployer transactions; and patterns_flows.py free RPC). Numbers re-scored both directions here.',
                      'Insiders moving tokens to an exchange usually sell. In this sample the opposite showed up: CEX-linked activity before the peak is a sign of a token big enough to reach CEX users.', core=wrap_counts(a['died']['n'], a['died']['flagged'], a['mooned']['n'], a['mooned']['flagged']), wraps=['patterns#3', 'nansen']))
    sb = E.jload('stables.json') or {}
    AJ.append(row('F3', 'Stablecoin mint/burn spikes', 'wrapped', 'wraps lib/stables.js (chain-level mint/burn + velocity; backtest in stables.json backtest_summary: 44 tests, no Bonferroni survivor). Market-level, not token-level: no per-token backtest on the memecoin set.', 'Large stablecoin mints onto a chain bring buying power; burns drain it.', wraps=['stables'],
                  live=[{'symbol': x.get('chain') or x.get('symbol'), 'why': str(x)[:120]} for x in (sb.get('active_spikes') or [])[:10]], extra={'backtest_summary': {k: sb.get('backtest_summary', {}).get(k) for k in ('n_tests', 'bonferroni_alpha_0.05')}}))
    ot = E.jload('riskinfra_otcflow.json') or {}
    AJ.append(row('F4', 'OTC desk / market-maker flows', 'wrapped', 'wraps lib/otcflow.js (labelled OTC/MM wallets on Ethereum). Majors-only; dark-pool data does not exist publicly for crypto (not-feasible).', 'Tokens moving from OTC desks or market makers to exchanges precede supply hitting the book.', wraps=['otcflow'],
                  live=[{'symbol': f.get('symbol') or f.get('token'), 'why': f.get('why') or str(f)[:120]} for f in (ot.get('flags') or [])[:10] if isinstance(f, dict)]))
    AJ.append(row('F5', 'Options flow: put/call ratio (Derive public data)', 'partial', 'live put/call OI ratio per underlying from the Derive snapshot (lib/derive.js). No option markets exist for the memecoin test set, and no free historical P/C series long enough to backtest (Deribit history is paid) — live only.',
                  'Very high put/call means hedging or bearish positioning; very low means crowded speculative longs. Both are contrarian warnings at extremes.', wraps=['derive'], live=put_call()))
    # ----- G -----
    tc = theme_crowding()
    cg1, fg1 = both_static(tc)
    AJ.append(row('G1', 'Theme crowding: >=3 same-theme launches in the prior 24h', 'built', 'research DB themes (topic model on token names/descriptions, narratives_taxonomy) + creation times across all 757 DB tokens', 'When the same meme theme is launched again and again within a day, the narrative is saturated and copies tend to die fast.', core=cg1, full=fg1,
                  live=[{'symbol': x.get('symbol'), 'key': x.get('key'), 'why': f"theme {x['features'].get('theme')} heat {x['features'].get('themeHeat')}"} for x in LF if (x.get('features') or {}).get('themeHeat', 0) >= 0.5][:20], wraps=['narratives']))
    gs = (E.jload('grok_signals.json') or {}).get('tokens') or {}
    sh = E.jload('sentiment_history.json') or {}
    AJ.append(row('G2', 'Sentiment velocity & divergence from price', 'wrapped', 'wraps lib/sentiment.js + lib/narratives.js + grok signals (read-only data/grok_signals.json, no new Grok spend). Historical sentiment is only free for majors (Wikipedia-attention proxy, 36 tokens: no reliable edge, see sentiment_history.json); memecoin social history needs paid X reads (not used).',
                  'Fast-rising hype while price stalls (or panic while price holds) is a divergence that often resolves against the crowd.', wraps=['sentiment', 'narratives', 'grok'], extra={'majors_backtest': sh.get('summary_line')},
                  live=[{'symbol': k, 'why': f"grok n={v.get('n')} sent={v.get('sent')} urg={v.get('maxUrg')} hack={v.get('hack')}"} for k, v in gs.items() if abs(v.get('sent') or 0) >= 30 or v.get('hack')][:15]))
    AJ.append(row('G3', 'Influence propagation speed / diffusion', 'not-feasible', 'needs post-level timelines and follower graphs (paid X reads — not allowed). Free Telegram/Discord/RSS mentions (socialalt) have no reliable timestamps per account to measure diffusion.', 'How fast a token mention spreads from a few accounts to many.'))
    # ----- H -----
    AJ.append(row('H1', 'MEV sandwich density (same wallet buy→sell within 2 s around others)', 'built', 'cached Nansen launch tapes; wraps lib/mev.js heuristics (terminal-swap sandwich audit). Jito tip anomalies are Pattern Lab #23 (not duplicated).',
                  'Heavy sandwiching means bots are farming the order flow: retail gets bad fills and the chart is inflated by bot volume.', core=tape_rule(f_sandwich), wraps=['mev', 'patternlab#23']))
    AJ.append(row('H2', 'Priority-fee / tip anomalies, block-inclusion timing', 'partial', 'Jito tips in the first 2 s are Pattern Lab #23; block-0 sniping is rule 44 here. Priority-fee distributions for every trade would need ~15k getTransaction calls on public RPC — not run.', 'Insiders pay unusually high priority fees to land in the launch block.', wraps=['patternlab#23']))
    AJ.append(row('H3', 'Gas griefing, reorgs, L2 sequencer downtime', 'not-feasible', 'Solana has no reorgs at finality and no sequencer; gas griefing is an EVM concept. Base sequencer downtime affects 11 Base tokens in the full set only and is market-wide (no token-level variance).', 'Network incidents freeze exits and cause liquidation cascades.'))
    # ----- I -----
    tpl = E.jload('contractscan_templates.json') or {}
    AJ.append(row('I1', 'Code similarity to known rug/honeypot contracts', 'wrapped', 'wraps contractscan_templates.json (EVM runtime-bytecode skeletons vs our confirmed honeypots; clone families in contractscan_corr.json). Solana pump.fun tokens all use the same SPL program, so code similarity has zero variance on the test set (not-feasible there).',
                  'A token whose bytecode skeleton matches previous rugs was probably made by the same kit.', wraps=['contractscan'], extra={'skeleton_families': len(tpl.get('skeletons') or {}), 'honeypot_library': tpl.get('honeypots')}))
    AJ.append(row('I2', 'Audit-firm reputation, symbolic execution (slither/mythril), formal verification', 'not-feasible', 'no test-set token has an audit; slither/mythril need verified Solidity source (not available for SPL tokens; most EVM memecoins unverified) — contractscan already simulates honeypots at bytecode level. Formal-verification results are only published for large DeFi protocols.', 'Audits by reputable firms and clean symbolic-execution reports lower (not remove) rug risk.'))
    # ----- J -----
    cj, fj = both_static(lambda t: None if t['db'].get('has_website') is None else not web1h(t))
    AJ.append(row('J1', 'No website / docs 1h after creation (and website changes)', 'partial', 'presence tested (time-aware, profile_delay_h) from research DB has_website. Wayback/DNS/hash diffs of project sites need the URL history per token; DexScreener profile URLs are not stored historically for the test set (proposal: daily hash of live-feed token sites).',
                  'Projects that never set up a site/docs — or that quietly change them — are lower-effort or preparing a pivot.', core=cj, full=fj))
    AJ.append(row('J2', 'NFT community crossover', 'not-feasible', 'no free mapping from memecoin holders to NFT collections on Solana without paid indexers (Nansen NFT endpoints are not in our allowed price list).', 'Tokens adopted by an existing NFT community have a built-in holder base.'))
    AJ.append(row('J3', 'Referral / points program launches attracting mercenary capital', 'not-feasible', 'no structured free feed of referral launches; would need scraping project announcements (paid X).', 'Referral programs pull in mercenary wallets that leave when rewards end.'))

    # ----- self-generated 43+ -----
    gen = [
        (43, 'Deployer sells in the early tape', f_dev_sell, 'The deployer wallet selling in the first trades is the classic soft rug.'),
        (44, 'Block-0 snipers: >=20% of early buy volume in the first 5 s', f_snipe, 'Wallets that buy within seconds of trading opening are usually insiders/bots who dump into the first wave of buyers.'),
        (45, 'Flippers: >=40% of first 100 buyers sell within 10 min', f_flip, 'If most early buyers flip within minutes, nobody is holding: the token has no base.'),
        (46, 'Buyer concentration: top-5 wallets >=50% of early buy volume', f_conc, 'A handful of wallets doing most of the buying controls the price and the exit.'),
        (47, 'Smart-money / KOL / high-balance wallets present early (>=2)', f_sm, 'Labelled skilled or well-funded wallets buying early often front-run a real move.'),
        (48, 'Sell ramp: sell share in last quarter >=55% and +15pp vs first quarter', f_sell_ramp, 'Selling takes over as the early phase goes on.'),
        (49, 'Round-trip wash: wallets with >=3 buys and >=3 sells carry >=20% of volume', f_wash, 'Volume made by the same wallets buying and selling back and forth is fake activity.'),
        (50, 'Bot-dominated tape: >=50% of trades by labelled trading bots', f_bots, 'Tapes dominated by Telegram trading-bot users are fast-money and churn quickly.'),
        (51, 'Serial deployers trading it (>=3 wallets labelled as other tokens\' deployers)', f_serial, 'Wallets that launch memecoins for a living buying each other\'s launches = farming circle.'),
        (52, 'Wallet velocity: >=150 distinct wallets in the first 30 min', f_velocity, 'Lots of distinct wallets arriving fast means real distribution.'),
        (53, 'Large median buy (>= $50)', f_bigbuys, 'Bigger typical tickets = real money rather than dust bots.'),
        (54, 'Mayhem-mode program participation (>=10 trades)', f_mayhem, 'pump.fun Mayhem-mode (agent-driven) trading in the early tape.'),
        (55, 'Activity collapse: trades in minutes 10-20 < 30% of minutes 0-10', f_slow, 'Interest disappearing right after launch.'),
    ]
    for gid, name, fn, ex in gen:
        G.append(row(gid, name, 'built', 'cached Nansen launch tapes (first 300 indexed trades)', ex, core=tape_rule(fn)))
    dbr = [
        (56, 'Repeat deployer: >=3 prior launches', lambda t: None if t['db'].get('dev_prior_tokens') is None else t['db']['dev_prior_tokens'] >= 3, 'Deployers who launch many tokens rarely support any of them.'),
        (57, 'No socials 1h after creation (no X, Telegram or website)', lambda t: soc1h(t) == 0, 'A token with no community channels has nobody to defend it. (time-aware: DexScreener profile_delay_h honoured so later-added socials do not leak.)'),
        (58, 'Fast bonding curve (<10 min to graduate)', lambda t: None if t['db'].get('curve_secs') is None else t['db']['curve_secs'] <= 600, 'Graduating in minutes is usually bundled/sniped buying, not organic demand.'),
        (59, 'Asia-hours launch (00-08 UTC)', lambda t: None if t['db'].get('launch_hour_utc') is None else t['db']['launch_hour_utc'] < 8, 'Launches while the US sleeps have thinner books.'),
        (60, 'DEX boost paid within 1h of creation', lambda t: None if t['db'].get('boost_count') is None else (t['db']['boost_count'] >= 1 and t['db'].get('first_boost_delay_h') is not None and t['db']['first_boost_delay_h'] <= 1), 'Paying for DexScreener boosts right at launch means a team spending on promotion (time-aware: boosts bought after the run are excluded).'),
    ]
    for gid, name, fn, ex in dbr:
        c, f = both_static(fn)
        G.append(row(gid, name, 'built', 'research DB static fields (flag_t = creation)', ex, core=c, full=f))
    E.save('patternlab_ext_aj.json', {'schema': 'patternlab-ext-v1', 'rows': AJ})
    E.save('patternlab_ext_gen.json', {'schema': 'patternlab-ext-v1', 'rows': G})
    for r in AJ + G:
        print(str(r['id']).ljust(4), r['status'][:8].ljust(8), r['name'][:50].ljust(50), 'C', r.get('hit_crashed'), 'R', r.get('hit_runners'), 'p', r.get('p_fisher'), r.get('separates'), 'lead c/p', r.get('crash_lead_h'), r.get('pump_lead_h'), 'live', r['n_live_flags'])

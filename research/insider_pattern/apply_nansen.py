"""Merge the 2026-10-11 Nansen run (data/insider_pattern_nansen_raw.json, 37 credits) into data/insider_pattern.json.
Adds per-candidate `nansen_verified`, `upgraded_from_reported`, `not_confirmed`; adjusts scores/rank where the new evidence warrants."""
import json
D=json.load(open('data/insider_pattern.json'))
L=json.load(open('data/insider_pattern_nansen_raw.json'))
N={
'LAB':dict(rank=1,scores=dict(P1=3,P2=1,P3=2,P4=1),confidence='high (on-chain path) / medium (intent)',
 nansen_verified=[
  'Apr 8 2026 14:58-15:03 UTC: five Safes 0x80b06923098c17c84e0564742d1a2d071d7ee29a (80,000,000), 0xf760b38e09282b11884a26e4ffb701eb0bd8de99 (64,814,995), 0x36fc85ec486c254c9564d66de8c4210a1a20c291 (22,788,000), 0xec99ab6394c3bb6e256c3dab3147ba37c2dcd375 (17,950,000), 0xa7d234a976917ea7995d0dcbee6d613ebabd559b (14,446,897) sent ~200.0M LAB to EOA 0xe03722dedbf090ad7a1c8f82ceb86637053e21dd (Nansen label "LAB Distributor"; gas first-funded by Bybit 14:20 UTC same day). Txs e.g. 0x834cf7e2e18773ba953dbfb35459a75f627669c96828cc7f93a45e43c89d1044, 0xac5725dd11e33cb89b4d5c05d8bdcb1efc3f4cd3ac04627e26679b2ca336313a',
  'RPC: all five source Safes are 3-of-4 with the same signers (0x74ae027e…, 0x8e4a7303…, 0x1664535c…, 0xf09c1932…) as LAB top-holder Safes 0x78a79d… and 0xf79ff8…',
  'Apr 8 15:44-15:53 UTC: Distributor -> Bitget deposits 0x77156a0a621d2ac7a075c0ac3172707c2e4aa191 (40,000,000; tx 0x9c237d1e…ffb00) and 0xe39f91a0daffc5547ada79a09be30b8556f7dfba (60,000,000; tx 0xf11e9579…c3), Gate deposit 0x8728f7d310d297e313f92624a060a6be9af6c496 (36,000,000; returned Apr 13) and 0x0e93898f… (59,999,892; returned Apr 13)',
  'Apr 23 18:11-18:27 UTC: Distributor -> 0xaa5e3b10… 50,000,000 -> 7 one-time hops in ~9 min -> 0xd073d2be05109cd8dbb766b50932aa4a32673a99 -> Bitget deposit 0xdd77bfbd… ; Distributor -> 0x7e1c3886… 45,999,892 -> 8 hops in ~16 min -> 0x1e8ea4785666a967c3b34a9db986a9fd105de166 -> Bitget deposit 0x6593aa6c…. At least 58,998,000 LAB reached Bitget via these two hop chains Apr 23-25 (top-60 rows only)',
  'May 11 15:36 - May 12 00:57 UTC: Bitget Main Wallet 0x1ab4973a… withdrew 99,999,579 LAB to exactly 10 wallets (0x82fc0b…, 0xf05ced…, 0xbcf077…, 0x093eb8…, 0xef80a2…, 0x7db446…, 0x7c62af…, 0x10e816…, 0x0d95e8…, 0x2d81ef…)',
  'Two of those, 0xf05ced86edc1857c977b70728f3c330e9e89b151 (9,000,000 on May 11, tx 0xe6ae236a…086e9) and 0x82fc0bc04c4326b679bf9dbdc60d653062bea31a (10,500,000, tx 0xe6556584…d014), funded the three Astherus depositors: Jul 10 02:43-02:50 UTC 2,613,571 / 2,507,913 / 2,871,272 and Jul 11 11:10-11:11 UTC 3,500,000 each to 0x76ccfd…, 0x628dd7…, 0xaad30c…'],
 upgraded_from_reported=['ZachXBT/Lookonchain: team funded an entity with >196M LAB in Apr 2026 via Bitget deposits -> VERIFIED (~200.0M from same-signer Safes via "LAB Distributor"; 136M direct to Bitget/Gate deposits, rest via hop chains)','~100M withdrawn to 10 wallets May 11-12 -> VERIFIED (99,999,579 to 10 wallets)','Those wallets fed the Jul 10-11 Aster selling -> VERIFIED for the deposit leg (2 of the 10 wallets -> 3 Astherus depositors, 22.99M LAB); the trades themselves were not pulled'],
 not_confirmed=['Which published allocation the five Safes represent']),
'LAPTOP':dict(rank=2,nansen_verified=[
  'Nansen labels: 0x246c846c945605222971e6ddeb45183ba7afacbb ("wallet F") = "LAPTOP Distributor"; 0xd81bf9…, 0x8aeaff…, 0xeff4d8…, 0xcb92b4… = "LAPTOP Multisig". Deployer Safe 0xf859bf… seeded them Sep 1 and Sep 8 01:04 UTC (tx 0x1a0f9b45…4a26: 300M founder Safe, 100M 0xeff4d8…, 50M Distributor, 50M 0xcb92b4…)',
  'Sep 9 12:06:13 UTC: Distributor -> 0xef36a582b2d7922ba238359448899d4d643096c3 30,000,000 (tx 0x1bd73c8de5a00d45eaa41331debacbe37dad16b8c51e106048ae1506b70dfbee; ~$51.9M at that minute). Nansen labels the recipient "GSR"',
  'Sep 18 00:52:27 UTC: Distributor -> fresh 0xb47e6c5cdefeb93022b85a193aed33cd837718d2 25,015,385 (tx 0x48335d27…7820) -> 01:00:45 0xae823f1b7a5ba8ff4c28e33fb01a5fd35b35dcf3 (tx 0x45608755…bb76) -> Sep 18-24: KuCoin deposit 0xca5798… 18,665,364 (8 txs), Gate deposit 0x40a03e… 4,013,072 (6), Kraken deposit 0xe2e69d… 2,336,959 (8); ~$2.16M at transfer-time prices'],
 upgraded_from_reported=['Bitquery/Trenchbook 30M to 0xEF36…96C3 at 12:06:13 UTC launch day -> VERIFIED (full address; Nansen labels it GSR, i.e. a market maker, not a fresh wallet)','25M via fresh 0xae823f… to KuCoin/Gate/Kraken -> VERIFIED with intermediate hop 0xb47e6c… and per-exchange amounts'],
 not_confirmed=['Whether wallet F = treasury bucket (Nansen calls it "Distributor"; disclosure mapping still not public)']),
'RAVE':dict(rank=3,confidence='high (on-chain path) / allegation-level (manipulation)',nansen_verified=[
  'Nov 2 2025: "RaveDAO: RAVE Multisig" 0x6020656d… -> Safe 0x53d7d52301366dc14e1916b14efec1add8f3487b 35,000,000 (tx 0x525d94d4…97c5). RPC: 0x53d7d5 is 4-of-5 sharing 4 signers with the 78.4% RaveDAO Multisig 0x9831156f…',
  'Apr 12 2026 11:57-15:39 UTC: 0x53d7d5 -> Bitget deposit 0x2dc20f2180582172f5450c5d71e23fa438a7031b 3,000,000 + 3,000,000 + 2,983,923 (txs 0xc9fbdc60…d454, 0x0e2c8653…8713, 0x1db9d972…cc1cd) and Gate deposit 0x31711246b05d71e9eda5e38a3abb654020ee3353 3,000,000 (tx 0x0335e4f5…acba9) = 11.98M (~$33.5M)',
  'Apr 19 2026 19:47:59 UTC: 0x53d7d5 -> fresh EOAs 0xf7631516008417a257313b1aec148f591447ada8 (12,996,077) and 0x7474f30f0ee0fef597d4a660c605b2b8480f0fe3 (10,000,000) in one tx 0xcea5f1602385c1a66a1747da7374fca831639f4b07fadfd059567df0d4921adc -> within 4-6 min Bitget deposits 0x64d6e91d… (12,986,077; tx 0x1b3d888f…e519) and 0x26ac542f… (9,998,999; tx 0x0c50e33d…afb6) = ~23.0M (~$26.6M)',
  'RaveDAO Multisig 0x6020656d… also sent directly to Gate deposit 0xfb7706… (333,333, Nov 25 2025), MEXC deposit 0xcd2ae2… (133,323, Dec 10) and LBank deposit 0xa6c490… (99,990, Dec 10)',
  'RaveDAO Multisig 0xeb74df… funded EOAs 0x2628c0… (4.25M) and 0xfe8320… (~1.58M), which paid recurring fixed amounts (18,750-40,000) to many wallets in Dec 2025-Feb 2026, incl. 0xa4b2b1… (Nansen label "Funded @langeriuseth On Friend.tech"; received 3 x 25,000; e.g. Dec 19 14:31 received, 14:36 sent 25,000 to Bitget deposit 0x554274…), 0x2fd011… ("Top 100 on CRCLON Leaderboard", 3 x 18,750, then MEXC deposit), teamcyber.eth, "MC Investor" 0x396d4a… (-> Gate deposit 40,000 x 3)'],
 upgraded_from_reported=['ZachXBT: deployer-linked wallets sent RAVE to Bitget before/around the pump -> VERIFIED for a same-signer Safe: ~32.0M to Bitget and 3.0M to Gate on Apr 12 and Apr 19 2026 (ZachXBT\'s 18.58M figure itself not reproduced)'],
 not_confirmed=['Purpose of the recurring fixed payouts (salary, KOL or grants); @langeriuseth handle not found on X today']),
'VELVET':dict(rank=4,scores=dict(P1=3,P2=2,P3=None,P4=1),nansen_verified=[
  'Mar 4 2026 06:30-09:54 UTC: fixed-amount wallet-to-wallet moves 0x6bff1c… -> 0x150c8a0aff9caefe3ce92658afa302e0172d1056 72,666,667 (tx 0x2c45f5a0b5dd96de44655800f652d392f27ca4e9e6871dacc4658db8f8911cc5), 0xcd5710… -> 0xe2e8fa… 35,000,000, 0xa3277d… -> 0x80952b… 28,193,720, 0x9d6abf… -> 0x3cf3d6… 10,000,000, 0x167e53… -> 0x515c18… 5,333,333. Sender 0x6bff1c… was gas-funded via ChangeNOW 74 min before; its VELVET inflow is not in Nansen BSC/Base data since Oct 2025',
  'Jun 7-9 2026: 0x150c8a… -> 18 Gate deposits 19,349,135 and 7 KuCoin deposits 7,001,753 VELVET (~$7.6M; top-60 rows), e.g. Jun 7 05:20 UTC tx 0x4fb1bb29…76d14',
  'May 20 - Jun 7 2026: 0x80952b… -> Bitget/MEXC/Gate/KuCoin deposits 8,847,761 VELVET; Jun 5 10:34-10:42 UTC 4,999,900 via 0xa6608a… -> 0xae8633… -> 0x25fc72… (two hops in 29 s)',
  'Velvet Safe 0xd19dce… sends ~0.56-1.0M VELVET monthly to creator 0x579d36…, which forwards it to SablierMerkleInstant contracts (reward distributions). No direct Safe/creator -> CEX transfer found Oct 2025-Jul 2026',
  'Jul 1 Gate depositors 0x2ef99d…, 0x7e64fa…, 0x9b4e1b… (and 0xa00155…, 0x798497…, 0x98dffe…, 0x8586ad…, 0x600772…) were funded by Bitget Main Wallet withdrawals Jun 22-30 (2.70M VELVET, often in identical 10,000/20,000 chunks at the same second), not by the Safes or creator',
  'P2: creator 0x579d36… -> thebullishtradr.eth 0x559acc031f14350dc7b309baa2195fb2def0351c 27,777 VELVET Dec 4 2025 06:26 UTC (tx 0xa290ea5d…7b3f); Safe 0xd19dce… -> same wallet 20,800 Nov 3 2025 (tx 0x09e860b8…905d). The wallet sold 15,000 + 12,777 via aggregators at 08:50-08:52 UTC the same day. X @TheBullishTradR (63.8K followers) posted "$VELVET … $1 is inevitable" Dec 17 2025 and many referral posts without #ad; described himself as "an affiliate of @Velvet_Capital" in a Dec 19 reply. ENS-to-X match is by name only'],
 upgraded_from_reported=['Bubblemaps: an address received 72M in March and sent ~$2.5M to CEX Jun 6-9 -> VERIFIED as 0x150c8a… (72,666,667 on Mar 4; ≥26.35M to Gate/KuCoin Jun 7-9). Its link to the creator is NOT confirmed by Nansen'],
 not_confirmed=['Creator/Safe origin of the Mar 4 fixed-amount tranches (upstream not visible)','Jul 1 Gate depositors funded by team (they were funded from Bitget)']),
'RIVER':dict(rank=5,nansen_verified=[
  'Nansen labels the wallets "RIVER Concentrated Supply Group". BSC Dec 3 2025 07:42-09:46 UTC Bitget Main Wallet withdrew to 0xe62e9e… (499,990), 0xd89a25… (449,990), 0x67902d0d325280f7775ab610caa6b312f1d2287c (399,990; Bubblemaps "0x6790…" distributor), 0xd499f9… (349,980), 0x6123d6… (300,000); Dec 29 to 0x69f240… (667,600) and 0xe4d5b3… (384,500)',
  'Dec 4 09:46-09:55 UTC: 0x67902d… fanned ~6,900-7,000 RIVER to ≥8 wallets, each forwarded again within ~13 min',
  'First funders: 0x67902d… and 0xe62e9e… were gas-funded at the same second (Dec 1 2025 04:39:16 UTC) by other group wallets; 0x37bb29… by 0x5fe93b… at 04:39:10'],
 upgraded_from_reported=['Bubblemaps cluster withdrew from Bitget Dec 3/29 -> VERIFIED on BSC, but amounts seen are ~2.8M RIVER, not 230M (other chains not queried)'],
 not_confirmed=['Funder 0x365b… / creator link (gas-funding tree only goes to other cluster wallets)']),
'M (MemeCore)':dict(rank=6,nansen_verified=[
  'Jun 20 2025 05:04 UTC: 207,200,000 M minted to 0x6f1f0a1ccc76d2d292249b19c19e401f0e843ba9 on BSC (tx 0xee78173336b4cddd2a82bca25410ff995f763a90fd5b1aa37b386eb9cce7cfc8)',
  'Jul 3 2025 (listing day): 0x6f1f0a… -> Kraken deposit 0xaa1f9fa46177aca98f5f433d88fe6d21d029c4a6 4,000,000 at 06:43 UTC (tx 0x89f9ca02…1244); -> PancakeSwap M-USDT 15,720,233 at 07:20 (~$865K); Jul 11 a further 4.49M into the same pool (~$3.06M)',
  'Jul 1: 0x6f1f0a… -> 0x06ef5775… 174,999,990 -> Jul 3 07:55-07:59 Binance 0x93deb6… 100,000,000 and "Binance: DEX/CEX Trading" 75,000,000 (~$9.6M)'],
 upgraded_from_reported=['ZachXBT: wallet got 200M at TGE and sent 5.3M to two Kraken deposits on listing day -> PARTLY VERIFIED: 207.2M minted to it; 4.0M to one Kraken deposit on BSC on Jul 3 2025'],
 not_confirmed=['Second Kraken deposit; promoter-reward addresses (on MemeCore L1, not covered)']),
'SIREN':dict(nansen_verified=['Cache: ~20 Hedgey-redeemer wallets forwarded their full balances within 5 seconds (11:13:08-11:13:13 UTC Mar 22 2026), two of them to Nansen-labeled "SIREN Custody Vaults" 0xf3689a9546c7e6fd466c8cd4a36f71891d72b2a8 (5,032,355 and 2,713,147)','First funders of 3 redeemers (0x2fc843…, 0x7eed30…, 0x6feff0…): different unlabeled wallets, all on Jan 15 2025 within 40 minutes'],
 upgraded_from_reported=['Dune: Hedgey self-locks redeemed and moved on -> VERIFIED with single-controller timing; custody-vault label suggests a project-side destination for part of it'],not_confirmed=['No outflows from the custody vault in Mar 22-May 15 in Nansen data']),
'COAI':dict(nansen_verified=['Nansen labels 0x8348bc… "COAI Multisig" and 0x7a181877986e7a0c60bc4a6b8a303c1968b5f13f "COAI Distributor"; all 8 same-key Safes sent test transfers to the Distributor Sep 25 2025 00:53-01:07 UTC','Sep 26 2025 16:21 UTC (day after TGE): Safe 0x24c667542ccd8d1d48f44c9b199e61cc65243c30 -> Bitget deposit 0x0e7bf0fe395f27b077ecdc285bd010d5081e1bec 10,000,000 COAI (~$1.69M; tx 0xb640a6e56a3b26b3e8e8ccb8f0d561c33c3ef787139517a183aedb89f8a8f561)'],
 upgraded_from_reported=[],not_confirmed=['Which bucket 0x24c667 is (could be a listing/MM allocation)']),
}
for c in D['candidates']:
    u=N.get(c['token'])
    if not u: continue
    for k,v in u.items(): c[k]=v
D['candidates'].sort(key=lambda c:c['rank'])
seen=set()
for i,c in enumerate(D['candidates'],1): c['rank']=i
D['nansen_run']={'date':'2026-10-11','credits_before':2038,'credits_after':2001,'credits_used':37,'cap':60,'paid_calls':37,'endpoints':{'tgm/transfers':27,'profiler/address/first-funder':8,'profiler/address/transactions':2},
 'free_calls':'account x4, search/entity-name x5','timeouts_not_charged':3,'raw':'data/insider_pattern_nansen_raw.json',
 'notes':['One profiler/address/transactions call (M, Jun-Aug 2025) returned only address-poisoning spam despite hide_spam_token','Not run: related-wallets, counterparties (5 credits), any labels endpoint (100-500 credits)']}
D['method']+='; + 37 Nansen credits on 2026-10-11 (tgm/transfers, first-funder, profiler transactions)'
json.dump(D,open('data/insider_pattern.json','w'),indent=1)
for c in D['candidates']: print(c['rank'],c['token'],c['scores'])

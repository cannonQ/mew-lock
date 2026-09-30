# MewLock Contract Audit

2026-09-30

One HIGH finding in `campaign.es` needs a one-line fix before deploy: sweeping two expired campaigns in one transaction lets the builder keep all but the largest. `position.es` is clean. Rating: campaign 6/10 as submitted (about 8.5/10 with the fix), position 9/10.

**Update (v3 retest):** v3 fixes F-1 and F-2, and MockChain confirms both fixes. One operational item remains: a live v2 campaign can still be swept together with a v3 campaign that pays the same fee address. See [v3 retest](#v3-retest).

## Findings

| ID | Severity | Contract | Lines | Finding | Fix size |
| --- | --- | --- | --- | --- | --- |
| F-1 | HIGH | campaign.es | 73–77 | Co-sweeping expired campaigns lets the builder keep all but the largest | 1 line |
| F-2 | LOW | campaign.es | 119–120, 131, 134 | Reward-token campaigns cannot create a zero-reward position | 1 line |
| F-4 | LOW | campaign.es | 140–145 | 1-nanoERG top-ups can repeatedly invalidate pending locks | Off-chain retry |
| F-5 | LOW | campaign.es | — | Deploy-time parameters must be set correctly (checklist below) | Launch checklist |
| F-3 | INFO | campaign.es | 94–100 | The last position marker can never be released | Mint extra markers |
| NV-1 | Needs test | campaign.es | 39–43, 97–99 | Header assumes untaken branches are never evaluated | MockChain probe |
| P-1 | INFO | position.es | 16 | Anyone holding a marker can create look-alike position boxes | Indexer / UI |
| P-2 | INFO | position.es | 2–6 | Header says "MewLock x Lithos" / LIT; the campaign is generic | Comment |
| P-3 | INFO | position.es | 16 | Owner key in R4 is locker-supplied; a bad key only hurts that user | Frontend |

Line numbers refer to the files as received.

## F-1: Co-sweeping campaigns leaks value to the builder

The sweep path checks the payout box against each campaign on its own and never pins the campaign to an input index. Two expired campaigns sharing a fee address can be swept together, and the fee address only has to receive the larger one.

```scala
sigmaProp(
  out.propositionBytes == _feeTree &&
  out.value >= SELF.value &&                              // per box, never summed
  (rewardIsErg || rewardIn(out) >= rewardIn(SELF)) &&
  burned
)
```

**Worked transaction**

| | Box | ERG |
| --- | --- | --- |
| Input 0 | Campaign C1 (past grace) | 100 |
| Input 1 | Campaign C2 (past grace) | 80 |
| Input 2 | Attacker's box (pays the fee) | fee |
| Output 0 | Fee address | 100 |
| Output 1 | Attacker | 80 |

C1 passes (100 ≥ 100) and C2 passes (100 ≥ 80); both NFTs and all markers are burned. With N campaigns, the builder keeps everything except the largest. The same applies to reward tokens when the campaigns pay the same token.

- **Who:** anyone, permissionless and profitable.
- **Precondition:** two or more unswept expired campaigns with the same `_feeTree`. The attacker only has to beat Mew's own sweeper.
- **Rating:** protocol-owned funds (residual budgets and reserves) × one actor with a realistic precondition = HIGH.
- **Not affected:** locks and top-ups. Two campaigns cannot both have their NFT at index 0 of `OUTPUTS(0)` (line 92), and a sweep cannot share `OUTPUTS(0)` with a lock or top-up (line 74 vs 91).

**Fix.** Only one box can be the first input, so any co-spent campaign fails its own check. A normal sweep with the campaign at input 0 still passes.

```scala
sigmaProp(
  SELF.id == INPUTS(0).id &&
  out.propositionBytes == _feeTree &&
  out.value >= SELF.value &&
  (rewardIsErg || rewardIn(out) >= rewardIn(SELF)) &&
  burned
)
```

## Other campaign.es findings

**F-2 (LOW): zero-reward positions cannot be built in reward-token campaigns.** When B is its own token and a small lock rounds the reward down to 0, `posTokens` still requires a B slot. A box cannot hold 0 of a token, so the frontend's transaction is rejected unless it adds an unrelated token. Fix:

```scala
val posTokens = 1 + (if (stakeIsErg) 0 else 1) + (if (rewardOwnToken && reward > 0L) 1 else 0)
```

Requiring `reward > 0L` instead also works, but it turns tiny locks away rather than letting them in with no reward.

**F-3 (INFO): the last marker is never released.** A lock needs the successor to hold `markers - 1`, and the successor must still carry the marker token. At 1 marker left that would be 0, which a box cannot hold. Capacity is the marker supply minus 1, so mint a large supply.

**F-4 (LOW): cheap contention on the campaign box.** A 1-nanoERG top-up is a valid state change. Anyone can spend the campaign box every block for the cost of a fee and make pending lock transactions fail. The damage is bounded and typical of a single shared box. The frontend should rebuild and retry against the latest box.

**NV-1 (needs a test): branch evaluation.** The header (lines 39–43) says each path's reads live in branches that are only evaluated when taken. The EKB's tested behaviour says an out-of-range collection read inside an untaken `if` branch still throws. The code uses `getOrElse` everywhere except typed register reads. If those are evaluated too, a top-up whose output 1 has an oddly typed R5–R8, or a sweep whose output 0 has a non-BigInt R4, would be rejected. The builder can always avoid this, so no funds are at risk. A quick MockChain probe settles it.

## position.es

The "can never get stuck" claim holds: the campaign's lock path requires R4 to be a GroupElement (line 128) and R5 to be an Int within `[HEIGHT + blocks, HEIGHT + blocks + _slack]` (lines 105, 129). A wrongly typed register makes the lock fail, so every campaign-created position is spendable by its owner after unlock.

- **P-1 (INFO): look-alike positions.** Markers are not burned when a position unlocks, and anything can be sent to the position address. Anyone holding a marker can create a box that looks like a position, with arbitrary R6–R8. No funds are at risk. Indexers and the UI should identify real positions by their creation transaction (the one that spent the campaign box), not by address plus marker.
- **P-2 (INFO): header mismatch.** The header says "MewLock x Lithos" and "the owner's LIT", but the campaign supports any asset, including ERG. Probably left over from a template.
- **P-3 (INFO): owner key.** R4 is whatever the locker supplies. A wrong key or the point at infinity only affects that user's own funds and reward. The frontend should fill R4 from the connected wallet.
- **Storage rent:** only relevant if a tier approaches 4 years; then `_deposit` must cover it.

## Pre-launch checklist (F-5)

The contract has no admin keys, so these constants and the initial box are set once and cannot be changed. Confirm each before deploying a campaign.

- [ ] F-1 fix applied and the campaign recompiled
- [ ] Campaign NFT minted with amount exactly 1 (a larger amount would let two same-NFT boxes be co-spent and leak one budget)
- [ ] Initial R4 holds a BigInt V greater than 0 (otherwise only the sweep path works)
- [ ] V sized for the expected lock sizes: a lock with weight equal to V takes half the budget
- [ ] `_positionTree` equals the exact compiled ErgoTree bytes of `position.es`
- [ ] `_slack` of about 10 blocks or more, so lock transactions stay valid in the mempool (0 means valid for one block only)
- [ ] Marker supply large enough for the expected number of locks, plus 1 (F-3)
- [ ] Reward-token campaigns start with at least 1 reward token at tokens(2)
- [ ] ERG-reward campaigns start with value of at least `_reserve`
- [ ] `_tierBlocks` and `_tierBoost` have the same length
- [ ] `_deposit` covers the minimum box value of a position with its tokens and registers
- [ ] `_feeTree` is the intended fee address

## Verified sound

- **Reward curve.** Two locks of weight w1 and w2 earn B(w1 + w2) / (V + w1 + w2), the same as one lock. Budget × V never increases, and rounding down makes splitting earn slightly less. The header claim on lines 16–17 holds.
- **Budget never runs out.** With V > 0 the maximum reward is always below the budget, so a reward-token budget never reaches 0.
- **Lock conservation.** The campaign loses exactly the reward (line 135), the position holds exactly principal plus reward (lines 131–134), and exactly one marker leaves (lines 100, 130).
- **No fake campaign box.** The successor must carry the same script and NFT (lines 91–92), and the position must use the exact position script (line 127).
- **NFT always preserved or burned.** Locks and top-ups keep it in the successor; the sweep burns it (lines 70–72).
- **Unlock height bounded on both sides** (line 129), so positions cannot be pushed far into the future.
- **Scripts compared in full**, not by a slice.
- **No overflow.** Weight is converted to BigInt before multiplying (line 111). The Long additions on lines 118 and 132 only overflow for impossible amounts, and would fail closed.
- **No data inputs or context variables**, so none can be substituted.

## v3 retest

v3 changes only two lines of code, both as recommended: the sweep requires `SELF.id == INPUTS(0).id` (F-1), and a zero reward in a separate reward token needs no token slot (F-2). The rest of the diff is comments.

**MockChain results** (fleet-sdk 0.12 MockChain, local only; `ensureInclusion` on and input count checked, so campaign scripts really executed). Reproduce with `cd audit/mockchain && npm i && npm test`.

| Check | Contract | Expected | Result |
| --- | --- | --- | --- |
| Two expired campaigns swept together | audited | accepted | accepted (attack works) |
| Two expired campaigns swept together | v3 | rejected | rejected |
| Normal single-campaign sweep | v3 | accepted | accepted |
| Zero-reward lock, reward in its own token | audited | rejected | rejected |
| Zero-reward lock, reward in its own token | v3 | accepted | accepted |
| Lock at the maximum reward | v3 | accepted | accepted |
| Lock asking 1 unit over the maximum | v3 | rejected | rejected |
| Top-up with Coll[Byte] in R4–R8 of `OUTPUTS(1)` (NV-1) | v3 | accepted | accepted |
| Sweep with Coll[Byte] R4 on the fee output (NV-1) | v3 | accepted | accepted |
| v3 (input 0) + v2 swept together, same fee address | v3 + v2 | — | **accepted** |
| v3 (input 0) + v2 swept together, different fee addresses | v3 + v2 | rejected | rejected |

**Status of findings**

| ID | Status |
| --- | --- |
| F-1 | Fixed in v3. Residual risk for live v2 campaigns (V3-1 below) |
| F-2 | Fixed in v3 |
| F-3, F-4, F-5 | Accepted by the team; no change needed |
| NV-1 | Closed: untaken-branch register reads do not reject (tested here, and by the team under sigmastate and sigma-rust) |
| P-1 | Accepted; the team's unlock burns the marker. UI filter by creation transaction is an optional follow-up |
| P-2 | Fixed (comment only) |
| P-3 | Accepted; the page uses the connected wallet's key |

**V3-1: a live v2 campaign can still be co-swept with a v3 campaign.** v3 only protects the campaign at input 0; v2 never checks its input index. With an expired v3 campaign at input 0 and an expired v2 campaign at input 1, one payout box to the shared fee address satisfies both, and the builder keeps the smaller amount. This held whichever campaign was larger. Deployed v2 campaigns cannot be upgraded, so the fix is operational:

- Give v3 campaigns a different fee address from any live v2 campaign. With different addresses, the combined sweep is rejected.
- Or make sure no v3 campaign expires while a v2 campaign is still unswept, and sweep v2 promptly once its grace period ends.
- Keep the fee address a plain wallet, as the team already plans.

## Scope

This is a quick review using the Ergo Knowledge Base (EKB) two-pass contract audit: a first pass, then an independent verification pass, on each contract, followed by the MockChain retest of v3 above. It does not include the full audit engagement: no two independent first passes, no node-level `/transactions/check` validation, and no review of the frontend or transaction builders.

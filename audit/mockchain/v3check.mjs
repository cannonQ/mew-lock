// Regression checks for campaign v3 on a local fleet-sdk MockChain (no network, no funds).
import { readFileSync } from "node:fs";
import { compile } from "@fleet-sdk/compiler";
import { TransactionBuilder, OutputBuilder } from "@fleet-sdk/core";
import { MockChain } from "@fleet-sdk/mock-chain";
import { SColl, SByte, SInt, SLong, SBigInt, SGroupElement } from "@fleet-sdk/serializer";

const ERG = 1_000_000_000n;
const tid = (n) => n.toString(16).padStart(64, "0");
const bytes = (h) => Uint8Array.from(Buffer.from(h, "hex"));
const NFT = tid(0x11), MK = tid(0x12), NFT2 = tid(0x21), MK2 = tid(0x22);
const TOK_A = tid(0xa1), TOK_B = tid(0xb2);
const DEPOSIT = 2_000_000n, BLOCKS = 100, BOOST = 10000n;
const START = 800_000, END = 900_000, GRACE = 100, SLACK = 20;

const chain = new MockChain({ height: 850_000 });
const fee = chain.newParty("fee");
const user = chain.newParty("user");
const posTree = compile(readFileSync("position.es", "utf8"), { version: 1 }).toHex();

function campaignTree(file, rewardId) {
  return compile(readFileSync(file, "utf8"), { version: 1, map: {
    _stakeId: SColl(SByte, bytes(rewardId === "" ? "" : TOK_A)), _rewardId: SColl(SByte, bytes(rewardId)),
    _positionTree: SColl(SByte, bytes(posTree)), _feeTree: SColl(SByte, bytes(fee.ergoTree)),
    _start: SInt(START), _end: SInt(END), _grace: SInt(GRACE), _slack: SInt(SLACK),
    _tierBlocks: SColl(SInt, [BLOCKS]), _tierBoost: SColl(SLong, [BOOST]),
    _minLock: SLong(1n), _deposit: SLong(DEPOSIT), _reserve: SLong(0n),
  } }).toHex();
}

function fresh(height) {
  chain.reset(); chain.jumpTo(height);
  user.withBalance({ nanoergs: 10n * ERG, tokens: [{ tokenId: TOK_A, amount: 1000n }] });
}
function exec(tx) { return chain.execute(tx, { signers: [user], throw: false }); }
function addCampaign(tree, value, assets, v) {
  const p = chain.addParty(tree, "campaign");
  p.addUTxOs([{ value, ergoTree: tree, assets, additionalRegisters: { R4: SBigInt(v).toHex() }, creationHeight: START }]);
  return p.utxos.toArray().at(-1);
}

// --- Sweep checks (ERG reward) ---
function coSweep(file) {
  fresh(1_000_000);
  const tree = campaignTree(file, "");
  const c1 = addCampaign(tree, 100n * ERG, [{ tokenId: NFT, amount: 1n }, { tokenId: MK, amount: 1000n }], 1n);
  const c2 = addCampaign(tree, 80n * ERG, [{ tokenId: NFT2, amount: 1n }, { tokenId: MK2, amount: 1000n }], 1n);
  const tx = new TransactionBuilder(chain.height).from([c1, c2, ...user.utxos.toArray()], { ensureInclusion: true })
    .to(new OutputBuilder(100n * ERG, fee.address))
    .burnTokens([{ tokenId: NFT, amount: 1n }, { tokenId: MK, amount: 1000n }, { tokenId: NFT2, amount: 1n }, { tokenId: MK2, amount: 1000n }])
    .sendChangeTo(user.address).payFee(1_000_000n).build();
  return [exec(tx), tx.inputs.length];
}
function honestSweep(file, oddR4) {
  fresh(1_000_000);
  const tree = campaignTree(file, "");
  const c1 = addCampaign(tree, 100n * ERG, [{ tokenId: NFT, amount: 1n }, { tokenId: MK, amount: 1000n }], 1n);
  const out = new OutputBuilder(100n * ERG, fee.address);
  if (oddR4) out.setAdditionalRegisters({ R4: SColl(SByte, [1, 2, 3]).toHex() });
  const tx = new TransactionBuilder(chain.height).from([c1, ...user.utxos.toArray()], { ensureInclusion: true })
    .to(out).burnTokens([{ tokenId: NFT, amount: 1n }, { tokenId: MK, amount: 1000n }])
    .sendChangeTo(user.address).payFee(1_000_000n).build();
  return [exec(tx), tx.inputs.length];
}

// --- Lock / top-up checks (A = TOK_A, B = TOK_B, B is its own token) ---
const BUDGET = 1_000_000n, PRINCIPAL = 100n;
function lock(file, V, reward) {
  fresh(850_000);
  const tree = campaignTree(file, TOK_B);
  const c = addCampaign(tree, 1n * ERG, [{ tokenId: NFT, amount: 1n }, { tokenId: MK, amount: 1000n }, { tokenId: TOK_B, amount: BUDGET }], V);
  const w = PRINCIPAL * BigInt(BLOCKS) * BOOST;
  const maxR = BUDGET * w / (V + w);
  if (reward === "max") reward = maxR;
  const succ = new OutputBuilder(1n * ERG, tree)
    .addTokens([{ tokenId: NFT, amount: 1n }, { tokenId: MK, amount: 999n }, { tokenId: TOK_B, amount: BUDGET - reward }])
    .setAdditionalRegisters({ R4: SBigInt(V + w).toHex() });
  const posTokens = [{ tokenId: MK, amount: 1n }, { tokenId: TOK_A, amount: PRINCIPAL }];
  if (reward > 0n) posTokens.push({ tokenId: TOK_B, amount: reward });
  const pos = new OutputBuilder(DEPOSIT, posTree).addTokens(posTokens).setAdditionalRegisters({
    R4: SGroupElement(user.address.getPublicKeys()[0]).toHex(),
    R5: SInt(chain.height + BLOCKS + 10).toHex(), R6: SLong(PRINCIPAL).toHex(),
    R7: SLong(reward).toHex(), R8: SInt(0).toHex() });
  const tx = new TransactionBuilder(chain.height).from([c, ...user.utxos.toArray()], { ensureInclusion: true })
    .to([succ, pos]).sendChangeTo(user.address).payFee(1_000_000n).build();
  return [exec(tx), `maxReward=${maxR}, reward=${reward}`];
}
function topUpOddOutput1(file) {
  fresh(850_000);
  const tree = campaignTree(file, TOK_B);
  const V = 100_000_000n;
  const c = addCampaign(tree, 1n * ERG, [{ tokenId: NFT, amount: 1n }, { tokenId: MK, amount: 1000n }, { tokenId: TOK_B, amount: BUDGET }], V);
  const succ = new OutputBuilder(2n * ERG, tree)
    .addTokens([{ tokenId: NFT, amount: 1n }, { tokenId: MK, amount: 1000n }, { tokenId: TOK_B, amount: BUDGET }])
    .setAdditionalRegisters({ R4: SBigInt(V).toHex() });
  const odd = SColl(SByte, [9, 9]).toHex();
  const out1 = new OutputBuilder(1n * ERG, user.address).setAdditionalRegisters({ R4: odd, R5: odd, R6: odd, R7: odd, R8: odd });
  const tx = new TransactionBuilder(chain.height).from([c, ...user.utxos.toArray()], { ensureInclusion: true })
    .to([succ, out1]).sendChangeTo(user.address).payFee(1_000_000n).build();
  return [exec(tx)];
}

const show = (label, r) => console.log(label.padEnd(62), JSON.stringify(r));
console.log("F-1 sweep");
show("  co-sweep two campaigns, audited contract (expect true)", coSweep("campaign.es"));
show("  co-sweep two campaigns, v3 (expect false)", coSweep("campaign_v3.es"));
show("  honest single sweep, v3 (expect true)", honestSweep("campaign_v3.es", false));
console.log("F-2 zero-reward lock, B its own token");
show("  zero-reward lock, audited contract (expect false)", lock("campaign.es", 10n ** 18n, 0n));
show("  zero-reward lock, v3 (expect true)", lock("campaign_v3.es", 10n ** 18n, 0n));
show("  max-reward lock, v3 (expect true)", lock("campaign_v3.es", 100_000_000n, "max"));
show("  over-max reward lock, v3 (expect false)", lock("campaign_v3.es", 100_000_000n, 500_001n));
console.log("NV-1 typed register reads in untaken branches");
show("  top-up, OUTPUTS(1) has Coll[Byte] in R4..R8, v3 (expect true)", topUpOddOutput1("campaign_v3.es"));
show("  sweep, fee output R4 is Coll[Byte], v3 (expect true)", honestSweep("campaign_v3.es", true));

// Mixed: a live v2 campaign co-swept with a v3 campaign that shares the fee address.
function mixed(v3Value, v2Value, sameFee) {
  fresh(1_000_000);
  const v3 = campaignTree("campaign_v3.es", "");
  let v2 = campaignTree("campaign.es", "");
  if (!sameFee) {
    const other = chain.newParty("other-fee");
    v2 = compile(readFileSync("campaign.es", "utf8"), { version: 1, map: {
      _stakeId: SColl(SByte, bytes("")), _rewardId: SColl(SByte, bytes("")),
      _positionTree: SColl(SByte, bytes(posTree)), _feeTree: SColl(SByte, bytes(other.ergoTree)),
      _start: SInt(START), _end: SInt(END), _grace: SInt(GRACE), _slack: SInt(SLACK),
      _tierBlocks: SColl(SInt, [BLOCKS]), _tierBoost: SColl(SLong, [BOOST]),
      _minLock: SLong(1n), _deposit: SLong(DEPOSIT), _reserve: SLong(0n) } }).toHex();
  }
  const a = addCampaign(v3, v3Value, [{ tokenId: NFT, amount: 1n }, { tokenId: MK, amount: 1000n }], 1n);
  const b = addCampaign(v2, v2Value, [{ tokenId: NFT2, amount: 1n }, { tokenId: MK2, amount: 1000n }], 1n);
  const top = v3Value > v2Value ? v3Value : v2Value;
  const tx = new TransactionBuilder(chain.height).from([a, b, ...user.utxos.toArray()], { ensureInclusion: true })
    .to(new OutputBuilder(top, fee.address))
    .burnTokens([{ tokenId: NFT, amount: 1n }, { tokenId: MK, amount: 1000n }, { tokenId: NFT2, amount: 1n }, { tokenId: MK2, amount: 1000n }])
    .sendChangeTo(user.address).payFee(1_000_000n).build();
  return [exec(tx), tx.inputs.length];
}
console.log("Mixed v2 + v3 co-sweep (v3 campaign at input 0)");
show("  same fee address, v3 100 / v2 80 ERG", mixed(100n * ERG, 80n * ERG, true));
show("  same fee address, v3 80 / v2 100 ERG", mixed(80n * ERG, 100n * ERG, true));
show("  different fee address for v3 (expect false)", mixed(100n * ERG, 80n * ERG, false));

import { ethers } from "ethers";
import { State, signState } from "@statechannels/nitro-protocol";
import { LEFT_CHAIN_ID, RIGHT_CHAIN_ID } from "../constants";
import {
  Executor,
  logBalances,
  logTotalGasSpentByAll,
  Responder,
  spinUpChains,
} from "../common/two-chain-setup";
import {
  challengeChannel,
  deployContractsToChain,
  fundChannelFully,
  pushOutcomeAndTransferAll,
} from "./helpers";
import {
  createHashLockChannel,
  fundChannel,
  preImage,
  correctPreImage,
  decodeHashLockedSwapData,
  defundChannel,
  encodeHashLockedSwapData,
  swap,
} from "./helpers";

const { leftChain: chain, rightChain, tearDownChains } = spinUpChains();

async function main() {
  // SETUP CONTRACTS ON BOTH CHAINS
  // Deploy the contracts to chain, and then reconnect them to their respective signers
  // for the rest of the interactions
  const [
    nitroAdjudicator,
    erc20AssetHolder,
    hashLock,
    token,
  ] = await deployContractsToChain(chain);

  const alice = ethers.Wallet.createRandom();
  const bob = ethers.Wallet.createRandom();

  const _preFund0 = createHashLockChannel(
    LEFT_CHAIN_ID,
    60,
    hashLock.address,
    erc20AssetHolder.address,
    alice,
    bob,
    ethers.utils.sha256(preImage),
  );

  await fundChannelFully(erc20AssetHolder, token, _preFund0);

  const unlock4: State = {
    ..._preFund0,
    turnNum: 4,
    appData: encodeHashLockedSwapData(correctPreImage),
    outcome: _preFund0.outcome,
  };
  await challengeChannel(nitroAdjudicator, unlock4, alice, bob);
  await pushOutcomeAndTransferAll(chain, nitroAdjudicator, unlock4, bob);

  // teardown blockchains
  await tearDownChains();
}

main();

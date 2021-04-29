import { ethers } from "ethers";
import { State } from "@statechannels/nitro-protocol";
import { LEFT_CHAIN_ID } from "../constants";
import { spinUpChains } from "../common/two-chain-setup";
import {
  challengeChannel,
  deployContractsToChain,
  fundChannelForDispute,
  pushOutcomeAndTransferAll,
} from "./helpers";
import {
  createHashLockChannel,
  preImage,
  correctPreImage,
  encodeHashLockedSwapData,
  swap,
} from "./helpers";

const { leftChain: chain, rightChain, tearDownChains } = spinUpChains();

/**
 * This function works through a dispute scenario and logs gas usage for each ethereum transaction.
 * The scenario is:
 * - A 2 participant hash lock channel.
 * - Alice and Bob deposit into the channel. Practically, only Bob needs to deposit
 * - Initial outcome is alice: 1 token, bob: 1 token
 * - Alice disputes the channel by revealing a pre-image.
 */
async function dispute() {
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

  await fundChannelForDispute(erc20AssetHolder, token, _preFund0);

  const unlock4: State = {
    ..._preFund0,
    turnNum: 4,
    appData: encodeHashLockedSwapData(correctPreImage),
    outcome: swap(_preFund0.outcome),
  };
  await challengeChannel(
    nitroAdjudicator,
    { ..._preFund0, turnNum: 3 },
    unlock4,
    alice,
    bob,
  );
  await pushOutcomeAndTransferAll(chain, nitroAdjudicator, unlock4, alice);

  // teardown blockchains
  await tearDownChains();
}

dispute();

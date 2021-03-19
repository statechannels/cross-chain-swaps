import { Contract, ethers } from "ethers";
import ganache = require("ganache-core");
import chalk = require("chalk");
import { LEFT_CHAIN_ID, RIGHT_CHAIN_ID } from "../constants";

const executorWallet = ethers.Wallet.createRandom();
const responderWallet = ethers.Wallet.createRandom();
const deployerWallet = ethers.Wallet.createRandom(); // to deploy contracts

export function spinUpChains() {
  const left = {
    gasPrice: ethers.constants.One.toHexString(),
    port: 9001,
    _chainId: LEFT_CHAIN_ID,
    _chainIdRpc: LEFT_CHAIN_ID,
    accounts: [
      {
        secretKey: executorWallet.privateKey,
        balance: ethers.constants.WeiPerEther.mul(800).toHexString(),
      },
      {
        secretKey: deployerWallet.privateKey,
        balance: ethers.constants.WeiPerEther.mul(800).toHexString(),
      },
    ],
  };
  const leftServer = (ganache as any).server(left);
  leftServer.listen(left.port, async (err) => {
    if (err) throw err;
    console.log(`ganache listening on port ${left.port}...`);
  });
  const leftChain = new ethers.providers.JsonRpcProvider(
    `http://localhost:${left.port}`
  );
  const right = {
    gasPrice: ethers.constants.One.toHexString(),
    port: 9002,
    _chainId: RIGHT_CHAIN_ID,
    _chainIdRpc: RIGHT_CHAIN_ID,
    accounts: [
      {
        secretKey: responderWallet.privateKey,
        balance: ethers.constants.WeiPerEther.mul(800).toHexString(),
      },
      {
        secretKey: deployerWallet.privateKey,
        balance: ethers.constants.WeiPerEther.mul(800).toHexString(),
      },
    ],
  };
  const rightServer = (ganache as any).server(right);
  rightServer.listen(right.port, async (err) => {
    if (err) throw err;
    console.log(`ganache listening on port ${right.port}...`);
  });
  const rightChain = new ethers.providers.JsonRpcProvider(
    `http://localhost:${right.port}`
  );

  async function tearDownChains() {
    await leftServer.close();
    await rightServer.close();
  }

  return {
    leftChain,
    rightChain,
    tearDownChains,
  };
}

export class Actor {
  prompt: "> " | "< " = "> ";
  color: string = "black";
  log(s: string) {
    console.log(chalk.keyword(this.color)(this.prompt + s));
  }
  gasSpent: number = 0;
  async getLeftBalance() {
    return this.leftToken.balanceOf(this.signingWallet.address);
  }
  async getRightBalance() {
    return this.rightToken.balanceOf(this.signingWallet.address);
  }
  async logBalances() {
    this.log(
      `I have ${(
        await this.getLeftBalance()
      ).toString()} tokens on the left chain`
    );
    this.log(
      `I have ${(
        await this.getRightBalance()
      ).toString()} tokens on the right chain`
    );
  }

  constructor(
    public signingWallet: ethers.Wallet,
    public leftToken: Contract, // TODO allow this to be undefined and fall back on an ETH swap
    public rightToken: Contract
  ) {}
}

export class Executor extends Actor {
  prompt: "> " | "< " = "> ";
  color: string = "orangered";
  constructor(leftToken: Contract, rightToken: Contract) {
    super(executorWallet, leftToken, rightToken);
  }
}

export class Responder extends Actor {
  prompt: "> " | "< " = "< ";
  color: string = "gray";
  constructor(leftToken: Contract, rightToken: Contract) {
    super(responderWallet, leftToken, rightToken);
  }
}

export async function logBalances(...actors: Actor[]) {
  for await (const actor of actors) {
    await actor.logBalances();
  }
}

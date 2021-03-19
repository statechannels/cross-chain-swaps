# Cross-chain swaps with state channels

This repo contains scripts that run atomic asset swapping between two local blockchains, using a hashlock approach.
See [this presentation](https://docs.google.com/presentation/d/1vpH7qXwYqnhkwgjTvZQUyZHk91BsJsth0aJas-ikpgE/edit#slide=id.gbe5b77ad24_0_24) for an overview.

To install dependencies, run `yarn` (install if necessary).

In [common/two-chain-setup.ts](./common/two-chain-setup.ts), there are functions that can be used to start two blockchains, and an `Executor` and `Responder` class representing two actors, each having an externally owned account on each chain and owning some tokens on just one chain or the other (initially). These actors will track the amout of gas expended during the swaps, and their token balances on ecah chain.

The approach taken here is to bypass the state channel wallets entirely; this avoids the need to manage any runtime dependencies such as a database or messaging system.

## Vector protocol

[Connext](https://connext.network/) have made cross-chain swaps their main focus, and are rolling out a network of liquidity pools to facilitate that.

In [vector-atomic-swap/happy-case.ts](./vector-atomic-swap/happy-case.ts), there is a typescript script which will setup the two chains, deploy the relevant contacts to both chains, and fund/defund channels to execute the swap. Note that the state channel message passing part, plus any checks that should be done in a real application, is currently incomplete.

Helper functions (specific to vector protocol) are located in `helpers.ts`.

Executing `yarn go-vector` will execute the script with ts-node. You should see color-coded output detailing the steps that happen and the gas expended.

## Nitro protocol

[Connext](https://connext.network/) have made cross-chain swaps their main focus, and are rolling out a network of liquidity pools to facilitate that.

In [nitro-atomic-swap/happy-case.ts](./nitro-atomic-swap/happy-case.ts), there is a script which will setup the two chains, deploy the relevant contacts to both chains, and fund/defund channels to execute the swap. Note that the state channel message passing part, plus any checks that should be done in a real application, is only partially complete.

Helper functions (specific to nitro protocol) are located in `helpers.ts`.

Executing `yarn go-nitro` will execute the script with ts-node. You should see color-coded output detailing the steps that happen and the gas expended.

## Future directions

- Complete the off-chain part of the swap in both protocols
- Explore unhappy paths where one or the other actor backs out of the swap
- Explore the security of the swap by trying to have one actor steal the other's coins.

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

Nitro protocol also supports atomic swaps. It might offer higher secutiry and lower gas costs.

In [nitro-atomic-swap/happy-case.ts](./nitro-atomic-swap/happy-case.ts), there is a script which will setup the two chains, deploy the relevant contacts to both chains, and fund/defund channels to execute the swap. Note that the state channel message passing part, plus any checks that should be done in a real application, is only partially complete.

Helper functions (specific to nitro protocol) are located in `helpers.ts`.

Executing `yarn go-nitro` will execute the script with ts-node. You should see color-coded output detailing the steps that happen and the gas expended.

The happy path looks like this:

[![](https://mermaid.ink/img/eyJjb2RlIjoic2VxdWVuY2VEaWFncmFtXG4gICAgcGFydGljaXBhbnQgRUNoYWluXG4gICAgcGFydGljaXBhbnQgRXhlY3V0b3JcbiAgICBwYXJ0aWNpcGFudCBSZXNwb25kZXJcbiAgICBwYXJ0aWNpcGFudCBSQ2hhaW5cbiAgICBFeGVjdXRvci0-PlJlc3BvbmRlcjogUHJlRjBcbiAgICBSZXNwb25kZXItPj5FeGVjdXRvcjogUHJlRjFcbiAgICBFeGVjdXRvci0-PkVDaGFpbjogRlVORFxuICAgIEV4ZWN1dG9yLT4-UmVzcG9uZGVyOiBQb3N0RjJcbiAgICBSZXNwb25kZXItPj5FeGVjdXRvcjogUG9zdEYzXG4gICAgUmVzcG9uZGVyLS0-PkV4ZWN1dG9yOiBwcmVGMFxuICAgIEV4ZWN1dG9yLS0-PlJlc3BvbmRlcjogcHJlRjFcbiAgICBSZXNwb25kZXItLT4-UkNoYWluOiBGVU5EXG4gICAgUmVzcG9uZGVyLT4-RXhlY3V0b3I6IHBvc3RGMlxuICAgIEV4ZWN1dG9yLT4-UmVzcG9uZGVyOiBwb3N0RjNcbiAgICBFeGVjdXRvci0tPj5SZXNwb25kZXI6IHVubG9jayhwKTRcbiAgICBFeGVjdXRvci0tPj5SZXNwb25kZXI6IElzRmluYWw1XG4gICAgUmVzcG9uZGVyLS0-PkV4ZWN1dG9yOiBJc0ZpbmFsNVxuICAgIEV4ZWN1dG9yLS0-PlJDaGFpbjogQ09OQ0xVREUgJiBXSVRIRFJBV1xuICAgICAgICBSZXNwb25kZXItPj5FeGVjdXRvcjogVW5sb2NrKHApNFxuICAgIFJlc3BvbmRlci0-PkV4ZWN1dG9yOiBpc0ZpbmFsNVxuICAgIEV4ZWN1dG9yLT4-UmVzcG9uZGVyOiBpc0ZpbmFsNVxuICAgIFJlc3BvbmRlci0-PkVDaGFpbjogQ09OQ0xVREUgJiBXSVRIRFJBV1xuICAgIFxuXG4iLCJtZXJtYWlkIjp7InRoZW1lIjoiZGVmYXVsdCJ9LCJ1cGRhdGVFZGl0b3IiOmZhbHNlfQ)](https://mermaid-js.github.io/mermaid-live-editor/#/edit/eyJjb2RlIjoic2VxdWVuY2VEaWFncmFtXG4gICAgcGFydGljaXBhbnQgRUNoYWluXG4gICAgcGFydGljaXBhbnQgRXhlY3V0b3JcbiAgICBwYXJ0aWNpcGFudCBSZXNwb25kZXJcbiAgICBwYXJ0aWNpcGFudCBSQ2hhaW5cbiAgICBFeGVjdXRvci0-PlJlc3BvbmRlcjogUHJlRjBcbiAgICBSZXNwb25kZXItPj5FeGVjdXRvcjogUHJlRjFcbiAgICBFeGVjdXRvci0-PkVDaGFpbjogRlVORFxuICAgIEV4ZWN1dG9yLT4-UmVzcG9uZGVyOiBQb3N0RjJcbiAgICBSZXNwb25kZXItPj5FeGVjdXRvcjogUG9zdEYzXG4gICAgUmVzcG9uZGVyLS0-PkV4ZWN1dG9yOiBwcmVGMFxuICAgIEV4ZWN1dG9yLS0-PlJlc3BvbmRlcjogcHJlRjFcbiAgICBSZXNwb25kZXItLT4-UkNoYWluOiBGVU5EXG4gICAgUmVzcG9uZGVyLT4-RXhlY3V0b3I6IHBvc3RGMlxuICAgIEV4ZWN1dG9yLT4-UmVzcG9uZGVyOiBwb3N0RjNcbiAgICBFeGVjdXRvci0tPj5SZXNwb25kZXI6IHVubG9jayhwKTRcbiAgICBFeGVjdXRvci0tPj5SZXNwb25kZXI6IElzRmluYWw1XG4gICAgUmVzcG9uZGVyLS0-PkV4ZWN1dG9yOiBJc0ZpbmFsNVxuICAgIEV4ZWN1dG9yLS0-PlJDaGFpbjogQ09OQ0xVREUgJiBXSVRIRFJBV1xuICAgICAgICBSZXNwb25kZXItPj5FeGVjdXRvcjogVW5sb2NrKHApNFxuICAgIFJlc3BvbmRlci0-PkV4ZWN1dG9yOiBpc0ZpbmFsNVxuICAgIEV4ZWN1dG9yLT4-UmVzcG9uZGVyOiBpc0ZpbmFsNVxuICAgIFJlc3BvbmRlci0-PkVDaGFpbjogQ09OQ0xVREUgJiBXSVRIRFJBV1xuICAgIFxuXG4iLCJtZXJtYWlkIjp7InRoZW1lIjoiZGVmYXVsdCJ9LCJ1cGRhdGVFZGl0b3IiOmZhbHNlfQ)

## Future directions

- Complete the off-chain part of the swap in both protocols
- Explore unhappy paths where one or the other actor backs out of the swap
- Explore the security of the swap by trying to have one actor steal the other's coins.

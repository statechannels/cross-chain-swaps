# Cross-chain swaps with state channels

## Minimum gas costs

Each of (Executor, Responder) must

- lock up their funds on one chain (at least 21K gas to move funds in)
- withdraw funds on the other chain (at least 21K gas to move funds out)

There's some more gas that needs to be spent by someone, to ensure the locked funds are safe.
There must be some storage for each channel, to record the funds locked up (per participant). Thats 20K to write when locking up, and 800 to read when unlocking. (There could be some refund happening when the channel is finished).

There's also a minimum of two signature recoveries (ECRECOVER 3K gas each = 6K) required when unlocking, and at least one hash to calculate. So we go up K at least.

All costs will rise if we consider tokens (e.g. ERC20) instead of ETH.

https://ethgastable.info/

## With nitro protocol

Funds lockup costs 49K, which is quite close to the lower bound for locking up securely (21K + 20K). There's some more gas spent on checks, event emission, and read-then-write flow for safely depositing.

## With vector protocol

Funds lockup costs 155K. The storage part of the lockup involves deploying a new contract via a proxy. It costs at least 32K (for CREATE or CREATE2 in this instance) to deploy a contract, plus an amount that depends on the contract bytecode size.

The nice thing about CREATE2 is that other participants don't need to call a function to deposit funds. But that is pretty useless for atomic swaps, since only one person deposits per channel anyway.

There's a separate transaction for depositing the actual ETH, which looks like it might not be required.

## With both vector an nitro?

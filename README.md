# solana-dao-voting

Full DAO governance — create proposals, vote with token weight, execute approved actions. Configurable quorum and voting periods.

![Rust](https://img.shields.io/badge/Rust-000000?logo=rust&logoColor=white)
![Solana](https://img.shields.io/badge/Solana-9945FF?logo=solana&logoColor=white)
![Anchor](https://img.shields.io/badge/Anchor-blue)
![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)

## Features

- Token-weighted voting
- Configurable quorum threshold
- Timed voting periods
- On-chain proposal execution

## Program Instructions

`initialize` | `create_proposal` | `vote` | `execute_proposal`

## Build

```bash
anchor build
```

## Test

```bash
anchor test
```

## Deploy

```bash
# Devnet
anchor deploy --provider.cluster devnet

# Mainnet
anchor deploy --provider.cluster mainnet
```

## Project Structure

```
programs/
  solana-dao-voting/
    src/
      lib.rs          # Program entry point and instructions
    Cargo.toml
tests/
  solana-dao-voting.ts           # Integration tests
Anchor.toml             # Anchor configuration
```

## License

MIT — see [LICENSE](LICENSE) for details.

## Author

Built by [Purple Squirrel Media](https://purplesquirrelmedia.io)

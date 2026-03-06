import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { PublicKey, Keypair, SystemProgram } from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  createMint,
  createAccount,
  mintTo,
  getAccount,
} from "@solana/spl-token";
import { assert } from "chai";
import { SolanaDaoVoting } from "../target/types/solana_dao_voting";

describe("solana-dao-voting", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace
    .solanaDaoVoting as Program<SolanaDaoVoting>;
  const authority = provider.wallet as anchor.Wallet;

  let governanceMint: PublicKey;
  let daoPda: PublicKey;
  let daoBump: number;
  let voteVault: Keypair;
  let proposalPda: PublicKey;
  let proposalBump: number;

  // Second voter
  const voter2 = Keypair.generate();
  let voter2TokenAccount: PublicKey;
  let authorityTokenAccount: PublicKey;

  const MIN_QUORUM = new anchor.BN(500_000);
  const VOTING_PERIOD = new anchor.BN(5); // 5 seconds for testing
  const TITLE = "Upgrade Treasury";
  const DESCRIPTION_HASH = Buffer.alloc(32, 1); // 32 bytes of 0x01
  const VOTE_AMOUNT = new anchor.BN(1_000_000);
  const MINT_AMOUNT = 10_000_000;

  before(async () => {
    // Airdrop to voter2
    const sig = await provider.connection.requestAirdrop(
      voter2.publicKey,
      2 * anchor.web3.LAMPORTS_PER_SOL
    );
    await provider.connection.confirmTransaction(sig);

    // Create governance mint
    governanceMint = await createMint(
      provider.connection,
      (authority as any).payer,
      authority.publicKey,
      null,
      6
    );

    // Derive DAO PDA
    [daoPda, daoBump] = PublicKey.findProgramAddressSync(
      [
        Buffer.from("dao"),
        authority.publicKey.toBuffer(),
        governanceMint.toBuffer(),
      ],
      program.programId
    );

    // Create vote vault keypair
    voteVault = Keypair.generate();

    // Create governance token accounts
    authorityTokenAccount = await createAccount(
      provider.connection,
      (authority as any).payer,
      governanceMint,
      authority.publicKey
    );

    voter2TokenAccount = await createAccount(
      provider.connection,
      (authority as any).payer,
      governanceMint,
      voter2.publicKey
    );

    // Mint governance tokens to both voters
    await mintTo(
      provider.connection,
      (authority as any).payer,
      governanceMint,
      authorityTokenAccount,
      authority.publicKey,
      MINT_AMOUNT
    );

    await mintTo(
      provider.connection,
      (authority as any).payer,
      governanceMint,
      voter2TokenAccount,
      authority.publicKey,
      MINT_AMOUNT
    );
  });

  it("create_dao — initializes DAO with governance mint", async () => {
    await program.methods
      .createDao(MIN_QUORUM, VOTING_PERIOD)
      .accounts({
        authority: authority.publicKey,
        governanceMint: governanceMint,
        dao: daoPda,
        voteVault: voteVault.publicKey,
        systemProgram: SystemProgram.programId,
        tokenProgram: TOKEN_PROGRAM_ID,
        rent: anchor.web3.SYSVAR_RENT_PUBKEY,
      })
      .signers([voteVault])
      .rpc();

    const dao = await program.account.dao.fetch(daoPda);
    assert.ok(dao.authority.equals(authority.publicKey));
    assert.ok(dao.governanceMint.equals(governanceMint));
    assert.equal(dao.proposalCount.toNumber(), 0);
    assert.equal(dao.minQuorum.toNumber(), MIN_QUORUM.toNumber());
    assert.equal(dao.votingPeriod.toNumber(), VOTING_PERIOD.toNumber());
    assert.equal(dao.bump, daoBump);

    // Verify vote vault ownership
    const vaultAccount = await getAccount(
      provider.connection,
      voteVault.publicKey
    );
    assert.ok(new PublicKey(vaultAccount.owner).equals(daoPda));
  });

  it("create_proposal — creates proposal with title and description hash", async () => {
    // Derive proposal PDA using proposal_count = 0
    const proposalId = new anchor.BN(0);
    [proposalPda, proposalBump] = PublicKey.findProgramAddressSync(
      [
        Buffer.from("proposal"),
        daoPda.toBuffer(),
        proposalId.toArrayLike(Buffer, "le", 8),
      ],
      program.programId
    );

    await program.methods
      .createProposal(TITLE, Array.from(DESCRIPTION_HASH))
      .accounts({
        proposer: authority.publicKey,
        dao: daoPda,
        proposal: proposalPda,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    const proposal = await program.account.proposal.fetch(proposalPda);
    assert.ok(proposal.dao.equals(daoPda));
    assert.ok(proposal.proposer.equals(authority.publicKey));
    assert.equal(proposal.id.toNumber(), 0);
    assert.equal(proposal.title, TITLE);
    assert.deepEqual(proposal.descriptionHash, Array.from(DESCRIPTION_HASH));
    assert.equal(proposal.yesVotes.toNumber(), 0);
    assert.equal(proposal.noVotes.toNumber(), 0);
    assert.equal(proposal.executed, false);
    assert.ok(proposal.expiresAt.toNumber() > proposal.createdAt.toNumber());

    // Verify dao proposal count incremented
    const dao = await program.account.dao.fetch(daoPda);
    assert.equal(dao.proposalCount.toNumber(), 1);
  });

  it("cast_vote — cast yes vote with token weight", async () => {
    // Derive vote record PDA for authority
    const [voteRecordPda] = PublicKey.findProgramAddressSync(
      [
        Buffer.from("vote"),
        proposalPda.toBuffer(),
        authority.publicKey.toBuffer(),
      ],
      program.programId
    );

    await program.methods
      .castVote(VOTE_AMOUNT, true) // yes vote
      .accounts({
        voter: authority.publicKey,
        dao: daoPda,
        proposal: proposalPda,
        voteRecord: voteRecordPda,
        voterTokenAccount: authorityTokenAccount,
        voteVault: voteVault.publicKey,
        systemProgram: SystemProgram.programId,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .rpc();

    const proposal = await program.account.proposal.fetch(proposalPda);
    assert.equal(proposal.yesVotes.toNumber(), VOTE_AMOUNT.toNumber());
    assert.equal(proposal.noVotes.toNumber(), 0);

    const voteRecord = await program.account.voteRecord.fetch(voteRecordPda);
    assert.ok(voteRecord.voter.equals(authority.publicKey));
    assert.ok(voteRecord.proposal.equals(proposalPda));
    assert.equal(voteRecord.amount.toNumber(), VOTE_AMOUNT.toNumber());
    assert.equal(voteRecord.side, true);

    // Verify tokens were locked in vault
    const vaultBalance = (
      await getAccount(provider.connection, voteVault.publicKey)
    ).amount;
    assert.equal(Number(vaultBalance), VOTE_AMOUNT.toNumber());
  });

  it("cast_vote — cast no vote from second voter", async () => {
    const noVoteAmount = new anchor.BN(200_000);

    const [voteRecordPda2] = PublicKey.findProgramAddressSync(
      [
        Buffer.from("vote"),
        proposalPda.toBuffer(),
        voter2.publicKey.toBuffer(),
      ],
      program.programId
    );

    await program.methods
      .castVote(noVoteAmount, false) // no vote
      .accounts({
        voter: voter2.publicKey,
        dao: daoPda,
        proposal: proposalPda,
        voteRecord: voteRecordPda2,
        voterTokenAccount: voter2TokenAccount,
        voteVault: voteVault.publicKey,
        systemProgram: SystemProgram.programId,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([voter2])
      .rpc();

    const proposal = await program.account.proposal.fetch(proposalPda);
    assert.equal(proposal.yesVotes.toNumber(), VOTE_AMOUNT.toNumber());
    assert.equal(proposal.noVotes.toNumber(), noVoteAmount.toNumber());
  });

  it("error: vote after voting ended", async () => {
    // Wait for the voting period to expire (5 seconds + buffer)
    await new Promise((resolve) => setTimeout(resolve, 6000));

    const lateVoter = Keypair.generate();
    const sig = await provider.connection.requestAirdrop(
      lateVoter.publicKey,
      2 * anchor.web3.LAMPORTS_PER_SOL
    );
    await provider.connection.confirmTransaction(sig);

    const lateVoterTokenAccount = await createAccount(
      provider.connection,
      (authority as any).payer,
      governanceMint,
      lateVoter.publicKey
    );

    await mintTo(
      provider.connection,
      (authority as any).payer,
      governanceMint,
      lateVoterTokenAccount,
      authority.publicKey,
      1_000_000
    );

    const [lateVoteRecordPda] = PublicKey.findProgramAddressSync(
      [
        Buffer.from("vote"),
        proposalPda.toBuffer(),
        lateVoter.publicKey.toBuffer(),
      ],
      program.programId
    );

    try {
      await program.methods
        .castVote(new anchor.BN(100_000), true)
        .accounts({
          voter: lateVoter.publicKey,
          dao: daoPda,
          proposal: proposalPda,
          voteRecord: lateVoteRecordPda,
          voterTokenAccount: lateVoterTokenAccount,
          voteVault: voteVault.publicKey,
          systemProgram: SystemProgram.programId,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([lateVoter])
        .rpc();
      assert.fail("Should have thrown VotingEnded error");
    } catch (err: any) {
      assert.include(err.toString(), "VotingEnded");
    }
  });

  it("execute_proposal — execute after voting passes", async () => {
    // Voting period should have expired by now (we waited 6s above)
    await program.methods
      .executeProposal()
      .accounts({
        dao: daoPda,
        proposal: proposalPda,
      })
      .rpc();

    const proposal = await program.account.proposal.fetch(proposalPda);
    assert.equal(proposal.executed, true);
  });

  it("error: execute without quorum", async () => {
    // Create a new proposal
    const dao = await program.account.dao.fetch(daoPda);
    const proposalId2 = dao.proposalCount;
    const [proposalPda2] = PublicKey.findProgramAddressSync(
      [
        Buffer.from("proposal"),
        daoPda.toBuffer(),
        proposalId2.toArrayLike(Buffer, "le", 8),
      ],
      program.programId
    );

    // Use a very short voting period so we've already set it to 5s in the DAO
    await program.methods
      .createProposal("No Quorum Test", Array.from(Buffer.alloc(32, 2)))
      .accounts({
        proposer: authority.publicKey,
        dao: daoPda,
        proposal: proposalPda2,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    // Cast a tiny yes vote (below quorum)
    const tinyVoter = Keypair.generate();
    const sig = await provider.connection.requestAirdrop(
      tinyVoter.publicKey,
      2 * anchor.web3.LAMPORTS_PER_SOL
    );
    await provider.connection.confirmTransaction(sig);

    const tinyVoterTokenAccount = await createAccount(
      provider.connection,
      (authority as any).payer,
      governanceMint,
      tinyVoter.publicKey
    );

    await mintTo(
      provider.connection,
      (authority as any).payer,
      governanceMint,
      tinyVoterTokenAccount,
      authority.publicKey,
      100
    );

    const [tinyVoteRecordPda] = PublicKey.findProgramAddressSync(
      [
        Buffer.from("vote"),
        proposalPda2.toBuffer(),
        tinyVoter.publicKey.toBuffer(),
      ],
      program.programId
    );

    await program.methods
      .castVote(new anchor.BN(100), true)
      .accounts({
        voter: tinyVoter.publicKey,
        dao: daoPda,
        proposal: proposalPda2,
        voteRecord: tinyVoteRecordPda,
        voterTokenAccount: tinyVoterTokenAccount,
        voteVault: voteVault.publicKey,
        systemProgram: SystemProgram.programId,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([tinyVoter])
      .rpc();

    // Wait for voting to end
    await new Promise((resolve) => setTimeout(resolve, 6000));

    try {
      await program.methods
        .executeProposal()
        .accounts({
          dao: daoPda,
          proposal: proposalPda2,
        })
        .rpc();
      assert.fail("Should have thrown QuorumNotMet error");
    } catch (err: any) {
      assert.include(err.toString(), "QuorumNotMet");
    }
  });
});

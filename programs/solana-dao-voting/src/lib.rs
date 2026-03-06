use anchor_lang::prelude::*;
use anchor_spl::token::{self, Mint, Token, TokenAccount, Transfer};

declare_id!("5Fbn6aG7dadaMY4vyCfaSuDPQFnR2zAqcp89MW1BoP6");

#[program]
pub mod solana_dao_voting {
    use super::*;

    pub fn create_dao(ctx: Context<CreateDao>, min_quorum: u64, voting_period: i64) -> Result<()> {
        let dao = &mut ctx.accounts.dao;
        dao.authority = ctx.accounts.authority.key();
        dao.governance_mint = ctx.accounts.governance_mint.key();
        dao.proposal_count = 0;
        dao.min_quorum = min_quorum;
        dao.voting_period = voting_period;
        dao.bump = ctx.bumps.dao;

        emit!(DaoInitialized {
            dao: dao.key(),
            authority: dao.authority,
            governance_mint: dao.governance_mint,
        });
        Ok(())
    }

    pub fn create_proposal(ctx: Context<CreateProposal>, title: String, description_hash: [u8; 32]) -> Result<()> {
        require!(title.len() <= 64, DaoError::TitleTooLong);
        let dao = &mut ctx.accounts.dao;
        let id = dao.proposal_count;
        dao.proposal_count = id.checked_add(1).ok_or(DaoError::Overflow)?;

        let proposal = &mut ctx.accounts.proposal;
        proposal.dao = dao.key();
        proposal.proposer = ctx.accounts.proposer.key();
        proposal.id = id;
        proposal.title = title.clone();
        proposal.description_hash = description_hash;
        proposal.yes_votes = 0;
        proposal.no_votes = 0;
        proposal.created_at = Clock::get()?.unix_timestamp;
        proposal.expires_at = proposal.created_at.checked_add(dao.voting_period).ok_or(DaoError::Overflow)?;
        proposal.executed = false;
        proposal.bump = ctx.bumps.proposal;

        emit!(ProposalCreated {
            dao: dao.key(),
            proposal: proposal.key(),
            proposer: proposal.proposer,
            proposal_id: id,
            description: title,
        });
        Ok(())
    }

    pub fn cast_vote(ctx: Context<CastVote>, amount: u64, side: bool) -> Result<()> {
        require!(amount > 0, DaoError::ZeroVote);
        let now = Clock::get()?.unix_timestamp;
        require!(now < ctx.accounts.proposal.expires_at, DaoError::VotingEnded);

        // Lock tokens in vote vault
        token::transfer(CpiContext::new(
            ctx.accounts.token_program.to_account_info(),
            Transfer {
                from: ctx.accounts.voter_token_account.to_account_info(),
                to: ctx.accounts.vote_vault.to_account_info(),
                authority: ctx.accounts.voter.to_account_info(),
            },
        ), amount)?;

        let proposal = &mut ctx.accounts.proposal;
        if side {
            proposal.yes_votes = proposal.yes_votes.checked_add(amount).ok_or(DaoError::Overflow)?;
        } else {
            proposal.no_votes = proposal.no_votes.checked_add(amount).ok_or(DaoError::Overflow)?;
        }

        let vote = &mut ctx.accounts.vote_record;
        vote.voter = ctx.accounts.voter.key();
        vote.proposal = proposal.key();
        vote.amount = amount;
        vote.side = side;
        vote.bump = ctx.bumps.vote_record;

        emit!(VoteCast {
            proposal: proposal.key(),
            voter: ctx.accounts.voter.key(),
            in_favor: side,
            weight: amount,
        });
        Ok(())
    }

    pub fn execute_proposal(ctx: Context<ExecuteProposal>) -> Result<()> {
        let proposal = &mut ctx.accounts.proposal;
        let dao = &ctx.accounts.dao;
        let now = Clock::get()?.unix_timestamp;
        require!(now >= proposal.expires_at, DaoError::VotingNotEnded);
        require!(!proposal.executed, DaoError::AlreadyExecuted);
        require!(proposal.yes_votes > proposal.no_votes, DaoError::ProposalRejected);
        require!(proposal.yes_votes >= dao.min_quorum, DaoError::QuorumNotMet);
        proposal.executed = true;

        emit!(ProposalExecuted {
            proposal: proposal.key(),
            yes_votes: proposal.yes_votes,
            no_votes: proposal.no_votes,
        });
        Ok(())
    }

    pub fn withdraw_vote(ctx: Context<WithdrawVote>) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        require!(now >= ctx.accounts.proposal.expires_at, DaoError::VotingNotEnded);

        let vote = &ctx.accounts.vote_record;
        let dao = &ctx.accounts.dao;
        let authority_key = dao.authority;
        let mint_key = dao.governance_mint;
        let bump = dao.bump;
        let seeds: &[&[u8]] = &[b"dao", authority_key.as_ref(), mint_key.as_ref(), &[bump]];

        token::transfer(CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            Transfer {
                from: ctx.accounts.vote_vault.to_account_info(),
                to: ctx.accounts.voter_token_account.to_account_info(),
                authority: ctx.accounts.dao.to_account_info(),
            },
            &[seeds],
        ), vote.amount)?;
        Ok(())
    }
}

#[derive(Accounts)]
pub struct CreateDao<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    pub governance_mint: Account<'info, Mint>,
    #[account(init, payer = authority, space = 8 + Dao::INIT_SPACE,
        seeds = [b"dao", authority.key().as_ref(), governance_mint.key().as_ref()], bump)]
    pub dao: Account<'info, Dao>,
    #[account(init, payer = authority, token::mint = governance_mint, token::authority = dao)]
    pub vote_vault: Account<'info, TokenAccount>,
    pub system_program: Program<'info, System>,
    pub token_program: Program<'info, Token>,
    pub rent: Sysvar<'info, Rent>,
}

#[derive(Accounts)]
#[instruction(title: String)]
pub struct CreateProposal<'info> {
    #[account(mut)]
    pub proposer: Signer<'info>,
    #[account(mut, seeds = [b"dao", dao.authority.as_ref(), dao.governance_mint.as_ref()], bump = dao.bump)]
    pub dao: Account<'info, Dao>,
    #[account(init, payer = proposer, space = 8 + Proposal::INIT_SPACE,
        seeds = [b"proposal", dao.key().as_ref(), &dao.proposal_count.to_le_bytes()], bump)]
    pub proposal: Account<'info, Proposal>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct CastVote<'info> {
    #[account(mut)]
    pub voter: Signer<'info>,
    pub dao: Account<'info, Dao>,
    #[account(mut, has_one = dao)]
    pub proposal: Account<'info, Proposal>,
    #[account(init, payer = voter, space = 8 + VoteRecord::INIT_SPACE,
        seeds = [b"vote", proposal.key().as_ref(), voter.key().as_ref()], bump)]
    pub vote_record: Account<'info, VoteRecord>,
    #[account(mut, constraint = voter_token_account.mint == dao.governance_mint)]
    pub voter_token_account: Account<'info, TokenAccount>,
    #[account(mut, constraint = vote_vault.mint == dao.governance_mint, constraint = vote_vault.owner == dao.key())]
    pub vote_vault: Account<'info, TokenAccount>,
    pub system_program: Program<'info, System>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct ExecuteProposal<'info> {
    pub dao: Account<'info, Dao>,
    #[account(mut, has_one = dao)]
    pub proposal: Account<'info, Proposal>,
}

#[derive(Accounts)]
pub struct WithdrawVote<'info> {
    pub voter: Signer<'info>,
    pub dao: Account<'info, Dao>,
    #[account(has_one = dao)]
    pub proposal: Account<'info, Proposal>,
    #[account(mut, has_one = voter, has_one = proposal, close = voter)]
    pub vote_record: Account<'info, VoteRecord>,
    #[account(mut, constraint = voter_token_account.mint == dao.governance_mint)]
    pub voter_token_account: Account<'info, TokenAccount>,
    #[account(mut, constraint = vote_vault.owner == dao.key())]
    pub vote_vault: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
}

#[account]
#[derive(InitSpace)]
pub struct Dao {
    pub authority: Pubkey,
    pub governance_mint: Pubkey,
    pub proposal_count: u64,
    pub min_quorum: u64,
    pub voting_period: i64,
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct Proposal {
    pub dao: Pubkey,
    pub proposer: Pubkey,
    pub id: u64,
    #[max_len(64)]
    pub title: String,
    pub description_hash: [u8; 32],
    pub yes_votes: u64,
    pub no_votes: u64,
    pub created_at: i64,
    pub expires_at: i64,
    pub executed: bool,
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct VoteRecord {
    pub voter: Pubkey,
    pub proposal: Pubkey,
    pub amount: u64,
    pub side: bool,
    pub bump: u8,
}

#[error_code]
pub enum DaoError {
    #[msg("Title too long (max 64)")]
    TitleTooLong,
    #[msg("Zero vote amount")]
    ZeroVote,
    #[msg("Voting period ended")]
    VotingEnded,
    #[msg("Voting period not ended")]
    VotingNotEnded,
    #[msg("Already executed")]
    AlreadyExecuted,
    #[msg("Proposal rejected: yes <= no")]
    ProposalRejected,
    #[msg("Quorum not met")]
    QuorumNotMet,
    #[msg("Overflow")]
    Overflow,
}

#[event]
pub struct DaoInitialized {
    pub dao: Pubkey,
    pub authority: Pubkey,
    pub governance_mint: Pubkey,
}

#[event]
pub struct ProposalCreated {
    pub dao: Pubkey,
    pub proposal: Pubkey,
    pub proposer: Pubkey,
    pub proposal_id: u64,
    pub description: String,
}

#[event]
pub struct VoteCast {
    pub proposal: Pubkey,
    pub voter: Pubkey,
    pub in_favor: bool,
    pub weight: u64,
}

#[event]
pub struct ProposalExecuted {
    pub proposal: Pubkey,
    pub yes_votes: u64,
    pub no_votes: u64,
}

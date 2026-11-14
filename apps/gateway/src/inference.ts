import { ProviderError } from './groq.js';

export interface Reservation {
  tokenId: string;
  sequence: string;
  commitment: string;
  transactionHash: string;
}

export interface InferenceJournal {
  record(job: string, phase: string, details?: object): Promise<void>;
}

export interface InferenceChain {
  reserveFinalized(accountId: string, tokenId: string, commitment: string): Promise<Reservation>;
  settleFinalized(reservation: Reservation, disposition: 'consume' | 'release'): Promise<string>;
}

export async function runInference(
  job: {id:string;accountId:string;tokenId:string;commitment:string;prompt:string},
  chain: InferenceChain,
  provider: (prompt:string)=>Promise<string>,
  journal: InferenceJournal,
) {
  await journal.record(job.id,'reserving',{commitment:job.commitment});
  const reservation = await chain.reserveFinalized(job.accountId,job.tokenId,job.commitment);
  if (reservation.tokenId !== job.tokenId || reservation.commitment !== job.commitment) {
    await journal.record(job.id,'manual_review',{reservation});
    throw Error('Finalized reservation does not match the request');
  }

  await journal.record(job.id,'calling_provider',{reservation});
  let output: string;
  try {
    output = await provider(job.prompt);
  } catch (error) {
    if (!(error instanceof ProviderError) || error.outcome !== 'rejected') {
      await journal.record(job.id,'manual_review',{reservation});
      throw Error('Provider outcome requires reconciliation');
    }
    await journal.record(job.id,'release_pending',{reservation});
    const transactionHash = await chain.settleFinalized(reservation,'release');
    await journal.record(job.id,'released',{reservation,transactionHash});
    throw Error('Provider rejected the request and the credit was released');
  }
  await journal.record(job.id,'consume_pending',{reservation,output});
  const transactionHash = await chain.settleFinalized(reservation,'consume');
  await journal.record(job.id,'completed',{reservation,transactionHash,output});
  return {output,reservation,transactionHash};
}

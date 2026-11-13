export default function Home() {
  return (
    <main className="mx-auto max-w-4xl px-6 py-24 sm:py-36">
      <p className="mb-8 font-mono text-sm font-semibold tracking-widest text-emerald-300">QUOTACARRY</p>
      <h1 className="max-w-3xl text-5xl font-semibold tracking-tight text-balance sm:text-7xl">
        Transfer AI compute rights, not API keys.
      </h1>
      <p className="mt-8 max-w-xl text-lg leading-relaxed text-slate-300">
        QuotaCarry is building NEAR NFT passes for bounded AI inference. Teams will issue
        allowances, and developers will be able to use, split, or transfer the available credits.
      </p>
      <p className="mt-6 text-sm text-slate-400">Foundation preview. Inference and wallet operations are planned.</p>
    </main>
  );
}

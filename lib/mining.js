// Bitcoin mining economics. Pure math + public network stats (mempool.space).

export const BLOCKS_PER_DAY = 144;
export const BLOCK_SUBSIDY_BTC = 3.125; // since the April 2024 halving; next halving ~2028 -> 1.5625

// Approximate manufacturer specs - verify against your unit before buying.
export const RIG_PRESETS = [
  { name: 'Antminer S21 XP', hashrateTHs: 270, watts: 3645 },
  { name: 'Antminer S21', hashrateTHs: 200, watts: 3500 },
  { name: 'Whatsminer M60S', hashrateTHs: 186, watts: 3441 },
  { name: 'Antminer S19 XP', hashrateTHs: 140, watts: 3010 },
  { name: 'Bitaxe (hobby, solo)', hashrateTHs: 1.2, watts: 18 },
];

export function miningProfit({ hashrateTHs, watts, kwhUsd, poolFeePct = 2, networkHashrateEHs, blockRewardBtc = BLOCK_SUBSIDY_BTC, feesPerBlockBtc = 0, btcUsd }) {
  const share = (hashrateTHs * 1e12) / (networkHashrateEHs * 1e18);
  const btcPerDay = share * BLOCKS_PER_DAY * (blockRewardBtc + feesPerBlockBtc) * (1 - poolFeePct / 100);
  const revenueUsd = btcPerDay * btcUsd;
  const kwhPerDay = (watts * 24) / 1000;
  const powerUsd = kwhPerDay * kwhUsd;
  return {
    btcPerDay, revenueUsd, powerUsd,
    profitUsd: revenueUsd - powerUsd,
    breakevenKwhUsd: revenueUsd / kwhPerDay,
    efficiencyJTH: watts / hashrateTHs,
  };
}

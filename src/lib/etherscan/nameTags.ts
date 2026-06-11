import { cacheLife, cacheTag } from 'next/cache'
import { etherscanGet } from './client'
import type { ContractSource, NameTagData } from './types'

/**
 * Static lookup of well-known public addresses that frequently appear as
 * top holders in institutional tokenized products. Sourced from Etherscan
 * public labels — verify at https://etherscan.io/labelcloud.
 *
 * Exported so the classify script can use it without the Next.js `use cache`
 * wrapper. Extend this table as new custodian/exchange addresses are identified.
 */
export const KNOWN_ADDRESSES: Record<string, string> = {
  '0x0000000000000000000000000000000000000000': 'Null Address',
  '0x000000000000000000000000000000000000dead': 'Dead Address (Burn)',
  // Major exchanges
  '0x71660c4005ba85c37ccec55d0c4493e66fe775d3': 'Coinbase',
  '0x503828976d22510aad0201ac7ec88293211d23da': 'Coinbase 2',
  '0x3cd751e6b0078be393132286c442345e5dc49699': 'Coinbase 4',
  '0x28c6c06298d514db089934071355e5743bf21d60': 'Binance Hot Wallet',
  '0xbe0eb53f46cd790cd13851d5eff43d12404d33e8': 'Binance Cold Wallet',
  '0x21a31ee1afc51d94c2efccaa2092ad1028285549': 'Binance: Hot Wallet 2',
  '0xf977814e90da44bfa03b6295a0616a897441acec': 'Binance: Hot Wallet 8',
  // Expand this table as top-holder addresses are identified
}

/**
 * Returns the best available name tag for an address:
 * 1. Static lookup (known exchanges, custodians)
 * 2. Contract name from Etherscan verified source code
 * 3. null if nothing found
 *
 * Cached for 24 hours per address. Etherscan does not expose its private
 * label database on the free API tier, so coverage is partial.
 */
export async function fetchNameTag(address: string): Promise<NameTagData> {
  'use cache'
  cacheTag('etherscan-data')
  cacheLife('days')

  const lower = address.toLowerCase()

  if (KNOWN_ADDRESSES[lower]) {
    return { address, nameTag: KNOWN_ADDRESSES[lower], source: 'static-lookup' }
  }

  const sources = await etherscanGet<ContractSource[]>({
    module: 'contract',
    action: 'getsourcecode',
    address,
  })

  const contractName = sources?.[0]?.ContractName
  if (contractName && contractName.trim() !== '') {
    return { address, nameTag: contractName, source: 'contract-name' }
  }

  return { address, nameTag: null, source: 'none' }
}

/** Batch fetch name tags, returning a map keyed by lowercase address. */
export async function fetchNameTags(
  addresses: string[]
): Promise<Record<string, NameTagData>> {
  const results = await Promise.all(addresses.map((a) => fetchNameTag(a)))
  return Object.fromEntries(results.map((r) => [r.address.toLowerCase(), r]))
}

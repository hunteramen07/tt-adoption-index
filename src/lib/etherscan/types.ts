// Etherscan API response envelope
export interface EtherscanResponse<T> {
  status: '0' | '1'
  message: string
  result: T
}

// Token holder from `tokenholderlist`
export interface TokenHolder {
  TokenHolderAddress: string
  /** Raw balance in smallest token units */
  TokenHolderQuantity: string
}

// Transfer event from `tokentx`
export interface ERC20Transfer {
  blockNumber: string
  timeStamp: string
  hash: string
  nonce: string
  blockHash: string
  from: string
  contractAddress: string
  to: string
  value: string
  tokenName: string
  tokenSymbol: string
  tokenDecimal: string
  transactionIndex: string
  gas: string
  gasPrice: string
  gasUsed: string
  cumulativeGasUsed: string
  input: string
  confirmations: string
}

// Contract source info from `getsourcecode`
export interface ContractSource {
  SourceCode: string
  ABI: string
  ContractName: string
  CompilerVersion: string
  OptimizationUsed: string
  Runs: string
  ConstructorArguments: string
  EVMVersion: string
  Library: string
  LicenseType: string
  Proxy: string
  Implementation: string
  SwarmSource: string
}

// Domain types returned by our fetchers

export interface HolderCountData {
  productSlug: string
  /** null when `tokenholdercount` is unavailable on the current API plan */
  holderCount: number | null
  fetchedAt: string
}

export interface EnrichedHolder {
  address: string
  /** Human-readable balance (divided by token decimals) */
  balance: string
  /** Raw balance in smallest token units */
  balanceRaw: string
  /** Share of total supply as a percentage, 0–100 */
  shareOfSupply: number
  nameTag: string | null
}

export interface TopHoldersData {
  productSlug: string
  totalSupplyRaw: string
  decimals: number
  holders: EnrichedHolder[]
  fetchedAt: string
}

export interface TransferHistoryData {
  productSlug: string
  transfers: ERC20Transfer[]
  totalCount: number
  lastBlock: number
  fetchedAt: string
  fromCache: boolean
}

export interface NameTagData {
  address: string
  nameTag: string | null
  source: 'static-lookup' | 'contract-name' | 'none'
}

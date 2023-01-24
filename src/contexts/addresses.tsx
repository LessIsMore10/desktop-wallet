/*
Copyright 2018 - 2022 The Alephium Authors
This file is part of the alephium project.

The library is free software: you can redistribute it and/or modify
it under the terms of the GNU Lesser General Public License as published by
the Free Software Foundation, either version 3 of the License, or
(at your option) any later version.

The library is distributed in the hope that it will be useful,
but WITHOUT ANY WARRANTY; without even the implied warranty of
MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
GNU Lesser General Public License for more details.

You should have received a copy of the GNU Lesser General Public License
along with the library. If not, see <http://www.gnu.org/licenses/>.
*/

import { AddressKeyPair, addressToGroup, getHumanReadableError, TOTAL_NUMBER_OF_GROUPS } from '@alephium/sdk'
import { AddressInfo, Transaction, UnconfirmedTransaction } from '@alephium/sdk/api/explorer'
import { merge } from 'lodash'
import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { PartialDeep } from 'type-fest'

import { useAppDispatch, useAppSelector } from '@/hooks/redux'
import AddressMetadataStorage from '@/persistent-storage/address-metadata'
import { addressesGenerated, addressGenerationStarted } from '@/store/actions'
import { AddressMetadata, AddressSettings } from '@/types/addresses'
import { NetworkName } from '@/types/network'
import { TimeInMs } from '@/types/numbers'
import { PendingTx } from '@/types/transactions'
import { convertUnconfirmedTxToPendingTx } from '@/utils/transactions'

import { useGlobalContext } from './global'

const deriveAddressesFromIndexesWorker = new Worker(
  new URL('../workers/deriveAddressesFromIndexes.ts', import.meta.url),
  { type: 'module' }
)
const deriveAddressesInGroupsWorker = new Worker(new URL('../workers/deriveAddressesInGroups.ts', import.meta.url), {
  type: 'module'
})

export type AddressHash = string

export class Address {
  readonly hash: AddressHash
  readonly shortHash: string
  readonly publicKey: string
  readonly privateKey: string
  readonly group: number
  readonly index: number

  settings: AddressSettings
  details: AddressInfo
  transactions: {
    confirmed: Transaction[]
    pending: PendingTx[]
    loadedPage: number
  }
  availableBalance: bigint
  lastUsed?: TimeInMs
  network?: NetworkName

  constructor(hash: string, publicKey: string, privateKey: string, index: number, settings: AddressSettings) {
    this.hash = hash
    this.shortHash = `${this.hash.substring(0, 10)}...`
    this.publicKey = publicKey
    this.privateKey = privateKey
    this.group = addressToGroup(hash, TOTAL_NUMBER_OF_GROUPS)
    this.index = index
    this.settings = settings
    this.details = {
      balance: '',
      lockedBalance: '',
      txNumber: 0
    }
    this.transactions = {
      confirmed: [],
      pending: [],
      loadedPage: 0
    }
    this.availableBalance = BigInt(0)
  }

  getName() {
    return this.settings.label || this.shortHash
  }

  addPendingTransaction(transaction: PendingTx) {
    console.log('🔵 Adding pending transaction sent from address: ', transaction.fromAddress)

    this.transactions.pending.push(transaction)
  }

  updatePendingTransactions() {
    const newPendingTransactions = this.transactions.pending.filter(
      (pendingTx) => !this.transactions.confirmed.find((confirmedTx) => confirmedTx.hash === pendingTx.txId)
    )

    this.transactions.pending = newPendingTransactions

    // Reduce the available balance of the address based on the total amount of pending transactions
    const pendingSweep = this.transactions.pending.find((tx) => tx.type === 'sweep' || tx.type === 'consolidation')
    const totalAmountOfPendingTxs = pendingSweep
      ? this.availableBalance
      : this.transactions.pending.reduce((acc, tx) => (tx.amount ? acc + BigInt(tx.amount) : acc), BigInt(0))
    this.availableBalance = this.availableBalance - totalAmountOfPendingTxs
  }
}

export type AddressesStateMap = Map<AddressHash, Address>

export interface AddressesContextProps {
  addresses: Address[]
  mainAddress?: Address
  getAddress: (hash: AddressHash) => Address | undefined
  setAddress: (address: Address) => void
  saveNewAddress: (address: Address, mnemonic?: string) => void
  updateAddressSettings: (address: Address, settings: AddressSettings) => void
  refreshAddressesData: () => void
  fetchAddressTransactionsNextPage: (address: Address) => void
  generateOneAddressPerGroup: (labelPrefix?: string, color?: string, skipGroups?: number[]) => void
  isLoadingData: boolean
}

export const initialAddressesContext: AddressesContextProps = {
  addresses: [],
  mainAddress: undefined,
  getAddress: () => undefined,
  setAddress: () => undefined,
  saveNewAddress: () => null,
  updateAddressSettings: () => null,
  refreshAddressesData: () => null,
  fetchAddressTransactionsNextPage: () => null,
  generateOneAddressPerGroup: () => null,
  isLoadingData: false
}

export const AddressesContext = createContext<AddressesContextProps>(initialAddressesContext)

export const AddressesContextProvider: FC<{ overrideContextValue?: PartialDeep<AddressesContextProps> }> = ({
  children,
  overrideContextValue
}) => {
  const { t } = useTranslation()
  const dispatch = useAppDispatch()
  const { activeWalletName, client, setSnackbarMessage } = useGlobalContext()
  const [{ mnemonic, isPassphraseUsed }, network] = useAppSelector((s) => [s.activeWallet, s.network])

  const previousNodeApiHost = useRef<string>()
  const previousExplorerApiHost = useRef<string>()

  const [addressesState, setAddressesState] = useState<AddressesStateMap>(new Map())
  const [isLoadingData, setIsLoadingData] = useState(false)
  const previousMnemonic = useRef<string | undefined>(mnemonic)

  const addressesOfCurrentNetwork = Array.from(addressesState.values()).filter(
    (addressState) => addressState.network === network.name
  )

  const addressesWithPendingSentTxs = addressesOfCurrentNetwork.filter(
    (address) => address.transactions.pending.filter((pendingTx) => pendingTx.network === network.name).length > 0
  )

  const constructMapKey = useCallback((addressHash: AddressHash) => `${addressHash}-${network.name}`, [network.name])

  const getAddress = useCallback(
    (addressHash: AddressHash) => addressesState.get(constructMapKey(addressHash)),
    [addressesState, constructMapKey]
  )

  const updateAddressesState = useCallback(
    (newAddresses: Address[]) => {
      if (newAddresses.length === 0) return
      setAddressesState((prevState) => {
        const newAddressesState = new Map(prevState)
        for (const newAddress of newAddresses) {
          newAddress.network = network.name
          newAddressesState.set(constructMapKey(newAddress.hash), newAddress)
        }
        return newAddressesState
      })

      console.log('✅ Updated addresses state: ', newAddresses)
    },
    [constructMapKey, network.name]
  )

  const setAddress = useCallback(
    (address: Address) => {
      updateAddressesState([address])
    },
    [updateAddressesState]
  )

  const updateAddressSettings = useCallback(
    (address: Address, settings: AddressSettings) => {
      if (!mnemonic) throw new Error('Could not update address settings, mnemonic not found')

      if (!isPassphraseUsed)
        AddressMetadataStorage.store(
          {
            mnemonic: mnemonic,
            walletName: activeWalletName
          },
          address.index,
          settings
        )
      address.settings = settings
      setAddress(address)
    },
    [mnemonic, isPassphraseUsed, activeWalletName, setAddress]
  )

  const displayDataFetchingError = useCallback(
    () =>
      setSnackbarMessage({
        text: t`Could not fetch data because the wallet is offline`,
        type: 'alert',
        duration: 5000
      }),
    [setSnackbarMessage, t]
  )

  const fetchPendingTxs = useCallback(
    async (addresses: Address[] = []) => {
      if (!client || network.status === 'offline') {
        displayDataFetchingError()
        return
      }
      setIsLoadingData(true)

      const addressesToCheck = addresses.length > 0 ? addresses : addressesOfCurrentNetwork

      for (const address of addressesToCheck) {
        try {
          console.log('🤷 Fetching unconfirmed txs for', address.hash)
          const { data: txs } = await client.explorer.addresses.getAddressesAddressUnconfirmedTransactions(address.hash)

          txs.forEach((tx) => {
            if (tx.type === 'Unconfirmed' && !address.transactions.pending.some((t: PendingTx) => t.txId === tx.hash)) {
              const pendingTx = convertUnconfirmedTxToPendingTx(
                tx as UnconfirmedTransaction,
                address.hash,
                network.name
              )

              address.addPendingTransaction(pendingTx)
            }
          })
        } catch (e) {
          setSnackbarMessage({
            text: getHumanReadableError(
              e,
              t('Error while fetching pending transactions for address {{ hash }}', { hash: address.hash })
            ),
            type: 'alert'
          })
        }
      }

      setIsLoadingData(false)
    },
    [client, network.status, addressesOfCurrentNetwork, displayDataFetchingError, network.name, setSnackbarMessage, t]
  )

  const fetchAndStoreAddressesData = useCallback(
    async (addresses: Address[] = [], checkingForPendingTransactions = false) => {
      if (!client || network.status === 'offline') {
        displayDataFetchingError()
        updateAddressesState(addresses)
        return
      }
      setIsLoadingData(true)

      const addressesToUpdate: Address[] = []

      // Refresh state for only the specified addresses, otherwise refresh all addresses of the current network
      const addressesStateToRefresh = addresses.length > 0 ? addresses : addressesOfCurrentNetwork
      console.log('🌈 Fetching addresses data from API: ', addressesStateToRefresh)

      // The state should always update when clicking the "refresh" button, but when checking for pending transactions
      // it should only update when at least one pending transaction has been confirmed.
      let shouldUpdate = !checkingForPendingTransactions

      for (const address of addressesStateToRefresh) {
        try {
          await client.fetchAddressDetails(address)
          await client.fetchAddressConfirmedTransactions(address)

          const initialNumberOfPendingTransactions = address.transactions.pending.length

          // Filter pending addresses and remove the ones that are now confirmed
          address.updatePendingTransactions()

          if (
            checkingForPendingTransactions &&
            address.transactions.pending.length !== initialNumberOfPendingTransactions
          ) {
            shouldUpdate = true
          }

          if (shouldUpdate) {
            addressesToUpdate.push(address)
          }
        } catch (e) {
          setSnackbarMessage({
            text: getHumanReadableError(
              e,
              t('Error while fetching data for address {{ hash }}', { hash: address.hash })
            ),
            type: 'alert'
          })
        }
      }

      if (shouldUpdate) {
        updateAddressesState(addressesToUpdate)
      }
      setIsLoadingData(false)
    },
    [
      client,
      network.status,
      addressesOfCurrentNetwork,
      displayDataFetchingError,
      updateAddressesState,
      setSnackbarMessage,
      t
    ]
  )

  const fetchAddressTransactionsNextPage = async (address: Address) => {
    if (!client || network.status === 'offline') return
    setIsLoadingData(true)
    await client.fetchAddressConfirmedTransactionsNextPage(address)
    setIsLoadingData(false)
  }

  const saveNewAddress = useCallback(
    (newAddress: Address, mnemonic?: string) => {
      const _mnemonic = mnemonic || mnemonic
      if (!_mnemonic) throw new Error('Could not save new address, mnemonic not found')

      if (!isPassphraseUsed)
        AddressMetadataStorage.store(
          {
            mnemonic: _mnemonic,
            walletName: activeWalletName
          },
          newAddress.index,
          newAddress.settings
        )
      setAddress(newAddress)
      fetchAndStoreAddressesData([newAddress])
      fetchPendingTxs([newAddress])
    },
    [activeWalletName, fetchAndStoreAddressesData, fetchPendingTxs, isPassphraseUsed, setAddress]
  )

  const generateOneAddressPerGroup = (labelPrefix?: string, labelColor?: string, skipGroups: number[] = []) => {
    if (!mnemonic) throw new Error('Could not generate addresses, mnemonic not found')

    dispatch(addressGenerationStarted())

    const skipAddressIndexes = addressesOfCurrentNetwork.map(({ index }) => index)
    const hasLabel = !!labelPrefix && !!labelColor
    const groups = Array.from({ length: TOTAL_NUMBER_OF_GROUPS }, (_, group) => group).filter(
      (group) => !skipGroups.includes(group)
    )

    deriveAddressesInGroupsWorker.onmessage = ({ data }: { data: (AddressKeyPair & { group: number })[] }) => {
      data.forEach(({ hash, publicKey, privateKey, index, group }) =>
        saveNewAddress(
          new Address(hash, publicKey, privateKey, index, {
            isMain: false,
            label: hasLabel ? `${labelPrefix} ${group}` : '',
            color: hasLabel ? labelColor : ''
          })
        )
      )

      dispatch(addressesGenerated())
      deriveAddressesInGroupsWorker.terminate()
    }

    deriveAddressesInGroupsWorker.postMessage({
      mnemonic: mnemonic,
      groups,
      skipIndexes: skipAddressIndexes
    })
  }

  // Initialize addresses state using the locally stored address metadata
  useEffect(() => {
    const initializeCurrentNetworkAddresses = async () => {
      console.log('🥇 Initializing current network addresses')
      if (!mnemonic) throw new Error('Could not initialize addresses, mnemonic not found')

      const addressesMetadata: AddressMetadata[] = isPassphraseUsed
        ? []
        : AddressMetadataStorage.load({
            mnemonic: mnemonic,
            walletName: activeWalletName
          })

      if (addressesMetadata.length > 0) {
        dispatch(addressGenerationStarted())

        console.log('👀 Found addresses metadata in local storage')

        deriveAddressesFromIndexesWorker.onmessage = async ({ data }: { data: AddressKeyPair[] }) => {
          const addressesToFetchData = data.map(({ hash, publicKey, privateKey, index }) => {
            const metadata = addressesMetadata.find((metadata) => metadata.index === index)

            return new Address(hash, publicKey, privateKey, index, {
              isMain: metadata?.isMain || false,
              label: metadata?.label,
              color: metadata?.color
            })
          })

          updateAddressesState(addressesToFetchData)
          await fetchAndStoreAddressesData(addressesToFetchData)
          await fetchPendingTxs(addressesToFetchData)
          dispatch(addressesGenerated())
        }

        deriveAddressesFromIndexesWorker.postMessage({
          mnemonic: mnemonic,
          indexesToDerive: addressesMetadata.map((metadata) => metadata.index)
        })
      }
    }

    const walletHasChanged = previousMnemonic.current !== mnemonic
    const networkSettingsHaveChanged =
      previousNodeApiHost.current !== network.settings.nodeHost ||
      previousExplorerApiHost.current !== network.settings.explorerApiHost

    if (network.status === 'connecting' || network.status === 'uninitialized') return

    // Clean state when locking the wallet or changing wallets
    if (mnemonic === undefined || mnemonic !== previousMnemonic.current) {
      console.log('🧽 Cleaning state.')
      setAddressesState(new Map())
      previousMnemonic.current = mnemonic
    }

    if (mnemonic && (client === undefined || walletHasChanged || networkSettingsHaveChanged)) {
      previousMnemonic.current = mnemonic
      previousNodeApiHost.current = network.settings.nodeHost
      previousExplorerApiHost.current = network.settings.explorerApiHost
      initializeCurrentNetworkAddresses()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    network.name,
    network.status,
    client,
    activeWalletName,
    mnemonic,
    network.settings.explorerApiHost,
    network.settings.nodeHost
  ])

  // Whenever the addresses state updates, check if there are pending transactions on the current network and if so,
  // keep querying the API until all pending transactions are confirmed.
  useEffect(() => {
    // In case the "to" address of a pending transaction is an address of this wallet, we need to query the API for this
    // one as well
    const addressesWithPendingReceivingTxs = addressesOfCurrentNetwork.filter((address) =>
      addressesWithPendingSentTxs.some((addressWithPendingTx) =>
        addressWithPendingTx.transactions.pending.some((pendingTx) => pendingTx.toAddress === address.hash)
      )
    )

    const addressesToRefresh = [...addressesWithPendingSentTxs, ...addressesWithPendingReceivingTxs]

    const interval = setInterval(() => {
      if (addressesToRefresh.length > 0) {
        console.log('❓ Checking if pending transactions are confirmed: ', addressesToRefresh)
        fetchAndStoreAddressesData(addressesToRefresh, true)
      } else {
        clearInterval(interval)
      }
    }, 2000)

    return () => {
      clearInterval(interval)
    }
  }, [addressesState, network.name, fetchAndStoreAddressesData, addressesOfCurrentNetwork, addressesWithPendingSentTxs])

  const refreshAddressesData = useCallback(async () => {
    await fetchAndStoreAddressesData()
    await fetchPendingTxs()
  }, [fetchAndStoreAddressesData, fetchPendingTxs])

  return (
    <AddressesContext.Provider
      value={merge(
        {
          addresses: addressesOfCurrentNetwork,
          mainAddress: addressesOfCurrentNetwork.find((address) => address.settings.isMain),
          getAddress,
          setAddress,
          saveNewAddress,
          updateAddressSettings,
          refreshAddressesData,
          fetchAddressTransactionsNextPage,
          generateOneAddressPerGroup,
          isLoadingData: isLoadingData || addressesWithPendingSentTxs.length > 0
        },
        overrideContextValue as AddressesContextProps
      )}
    >
      {children}
    </AddressesContext.Provider>
  )
}

export const useAddressesContext = () => useContext(AddressesContext)

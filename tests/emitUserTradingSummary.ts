import * as anchor from '@coral-xyz/anchor';
import { assert } from 'chai';

import { Program } from '@coral-xyz/anchor';

import {
	BN,
	OracleSource,
	TestClient,
	PRICE_PRECISION,
	PositionDirection,
	EventSubscriber,
	BASE_PRECISION,
	OrderType,
} from '../sdk/src';

import {
	mockOracleNoProgram,
	mockUSDCMint,
	mockUserUSDCAccount,
	initializeQuoteSpotMarket,
} from './testHelpers';
import { startAnchor } from 'solana-bankrun';
import { TestBulkAccountLoader } from '../sdk/src/accounts/testBulkAccountLoader';
import { BankrunContextWrapper } from '../sdk/src/bankrun/bankrunConnection';

describe('emit user trading summary', () => {
	const chProgram = anchor.workspace.Drift as Program;

	let driftClient: TestClient;
	let eventSubscriber: EventSubscriber;

	let bulkAccountLoader: TestBulkAccountLoader;

	let bankrunContextWrapper: BankrunContextWrapper;

	let usdcMint;
	let userUSDCAccount;
	let userAccountPk;

	// ammInvariant == k == x * y
	const mantissaSqrtScale = new BN(Math.sqrt(PRICE_PRECISION.toNumber()));
	const ammInitialQuoteAssetReserve = new anchor.BN(5 * 10 ** 13).mul(
		mantissaSqrtScale
	);
	const ammInitialBaseAssetReserve = new anchor.BN(5 * 10 ** 13).mul(
		mantissaSqrtScale
	);

	const usdcAmount = new BN(10 * 10 ** 6);

	before(async () => {
		const context = await startAnchor('', [], []);

		bankrunContextWrapper = new BankrunContextWrapper(context);

		bulkAccountLoader = new TestBulkAccountLoader(
			bankrunContextWrapper.connection,
			'processed',
			1
		);

		eventSubscriber = new EventSubscriber(
			bankrunContextWrapper.connection.toConnection(),
			chProgram
		);

		await eventSubscriber.subscribe();

		usdcMint = await mockUSDCMint(bankrunContextWrapper);
		userUSDCAccount = await mockUserUSDCAccount(
			usdcMint,
			usdcAmount,
			bankrunContextWrapper
		);

		const oracle = await mockOracleNoProgram(bankrunContextWrapper, 1);

		driftClient = new TestClient({
			connection: bankrunContextWrapper.connection.toConnection(),
			wallet: bankrunContextWrapper.provider.wallet,
			programID: chProgram.programId,
			opts: {
				commitment: 'confirmed',
			},
			activeSubAccountId: 0,
			perpMarketIndexes: [0],
			spotMarketIndexes: [0],
			subAccountIds: [],
			oracleInfos: [
				{
					publicKey: oracle,
					source: OracleSource.PYTH,
				},
			],
			accountSubscription: {
				type: 'polling',
				accountLoader: bulkAccountLoader,
			},
		});

		await driftClient.initialize(usdcMint.publicKey, true);
		await driftClient.subscribe();

		await initializeQuoteSpotMarket(driftClient, usdcMint.publicKey);
		await driftClient.updatePerpAuctionDuration(new BN(0));

		const periodicity = new BN(0);

		await driftClient.initializePerpMarket(
			0,
			oracle,
			ammInitialBaseAssetReserve,
			ammInitialQuoteAssetReserve,
			periodicity
		);

		const [_, userAccountPubkey] =
			await driftClient.initializeUserAccountAndDepositCollateral(
				usdcAmount,
				userUSDCAccount.publicKey
			);

		userAccountPk = userAccountPubkey;

		await driftClient.placePerpOrder({
			marketIndex: 0,
			baseAssetAmount: BASE_PRECISION,
			direction: PositionDirection.LONG,
			orderType: OrderType.LIMIT,
			price: PRICE_PRECISION,
		});
	});

	after(async () => {
		await driftClient.unsubscribe();
		await eventSubscriber.unsubscribe();
	});

	it('emits user trading summary', async () => {
		const sig = await driftClient.emitUserTradingSummary(userAccountPk);

		await eventSubscriber.awaitTx(sig);
		const event = eventSubscriber.getEventsArray('UserTradingSummaryRecord')[0];

		assert(event.authority.equals(driftClient.authority));
		assert(event.openOrderCount == 1);
		assert(event.settledPerpPnl.isZero());
		assert(event.status == 0);
	});
});

import type { Api, Model, ModelsStoreEntry, Provider } from "@earendil-works/pi-ai";

function mergeModels(baseline: readonly Model<Api>[], dynamic: readonly Model<Api>[]): Model<Api>[] {
	const merged = [...baseline];
	for (const model of dynamic) {
		const index = merged.findIndex((entry) => entry.id === model.id);
		if (index >= 0) merged[index] = model;
		else merged.push(model);
	}
	return merged;
}

function remoteModels(
	entry: ModelsStoreEntry | undefined,
	localGeneratedAt: number | undefined,
): readonly Model<Api>[] {
	if (!entry) return [];
	if (localGeneratedAt !== undefined && (entry.lastModified === undefined || entry.lastModified <= localGeneratedAt)) {
		return [];
	}
	return entry.models;
}

/**
 * Apply a persisted catalog overlay to a static built-in provider.
 *
 * Fork (issue #32): the pi.dev overlay fetch is purged. Refresh restores any
 * previously persisted overlay from the local models store and never touches
 * the network, regardless of `allowNetwork`/`force`.
 */
export function withRemoteCatalog(provider: Provider, localGeneratedAt?: number): Provider {
	let dynamicModels: readonly Model<Api>[] = [];

	return {
		...provider,
		getModels: () => mergeModels(provider.getModels(), dynamicModels),
		refreshModels: async (context) => {
			const restored = remoteModels(context.stored, localGeneratedAt).filter(
				(model) => model.provider === provider.id,
			);
			await context.publish({
				update: () => {
					dynamicModels = restored;
				},
			});
		},
	};
}

import { type AnyModel, getModelType, isModelType, type ModelsStoreEntry, type Provider } from "@earendil-works/pi-ai";

function mergeModels<TModel extends AnyModel>(baseline: readonly TModel[], dynamic: readonly TModel[]): TModel[] {
	const merged = new Map<string, TModel>();
	for (const model of [...baseline, ...dynamic]) merged.set(`${getModelType(model)}\0${model.id}`, model);
	return [...merged.values()];
}

function remoteModels(entry: ModelsStoreEntry | undefined, localGeneratedAt: number | undefined): readonly AnyModel[] {
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
	let dynamicModels: readonly AnyModel[] = [];

	return {
		...provider,
		getModels: () =>
			mergeModels(
				provider.getModels(),
				dynamicModels.filter((model) => isModelType(model, "chat")),
			),
		getAllModels: () => mergeModels(provider.getAllModels?.() ?? provider.getModels(), dynamicModels),
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

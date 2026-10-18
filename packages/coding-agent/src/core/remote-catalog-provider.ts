import {
	type AnyModel,
	getModelType,
	isModelType,
	type ModelsStoreEntry,
	type Provider,
	type RefreshModelsContext,
} from "@earendil-works/pi-ai";

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

/** Replaces the catalog with a credential-specific model list. */
export type PersonalizeCatalog = (
	catalog: readonly AnyModel[],
	context: RefreshModelsContext,
) => Promise<readonly AnyModel[]>;

/**
 * Like `withRemoteCatalog`, but on each network refresh the catalog is passed through `personalize`
 * and the result is saved. The saved entry holds the personalized list and replaces the catalog,
 * including offline. An empty list (nothing saved yet) falls back to the built-in models.
 *
 * Fork (issue #32): the pi.dev catalog fetch that seeds upstream's remote overlay is purged;
 * `personalize` runs over the built-in models, so the only network call is the provider's own
 * endpoint with the user's credential (the sanctioned user-configured-provider class).
 */
export function withPersonalizedCatalog(provider: Provider, personalize: PersonalizeCatalog): Provider {
	let personalModels: readonly AnyModel[] = [];
	const builtinModels = (): readonly AnyModel[] => provider.getAllModels?.() ?? provider.getModels();
	const getAllModels = (): readonly AnyModel[] => (personalModels.length > 0 ? personalModels : builtinModels());

	return {
		...provider,
		getModels: () => getAllModels().filter((model) => isModelType(model, "chat")),
		getAllModels,
		refreshModels: async (context) => {
			const restored = (context.stored?.models ?? []).filter((model) => model.provider === provider.id);
			if (
				!(await context.publish({
					update: () => {
						personalModels = restored;
					},
				}))
			) {
				return;
			}
			if (!context.allowNetwork || context.signal.aborted) return;

			const personalized = await personalize(builtinModels(), context);
			if (context.signal.aborted) return;
			await context.publish({
				persist: { models: personalized, checkedAt: Date.now() },
				update: () => {
					personalModels = personalized;
				},
			});
		},
	};
}

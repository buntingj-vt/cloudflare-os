export type CloudflareAccountConfiguratorValues = {
  /** No user-selectable values: the configurator confirms the connected account. */
  confirmed?: string | null;
};

export interface CloudflareAccountConfiguratorRpc {
  /** The canonical resource URL (the connected account's dashboard URL). */
  resourceUrl(): Promise<string>;
  /** A human-readable descriptor of the connected account, shown in the picker. */
  describeAccount(): Promise<{ accountId: string }>;
}

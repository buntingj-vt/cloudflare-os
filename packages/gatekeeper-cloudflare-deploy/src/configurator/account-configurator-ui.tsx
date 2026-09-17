import { Field, h, Section, type ConfiguratorUISpec } from "@gadgets/configurator-ui";
import type {
  CloudflareAccountConfiguratorRpc,
  CloudflareAccountConfiguratorValues,
} from "./account-configurator-types";

// The account resource has no user-selectable inputs — once connected, the resource URL is fully
// determined by the account. The configurator just confirms which account is being granted.

export default {
  initial: { confirmed: "yes" },

  isReady() {
    return true;
  },

  resourceUrl({ ui }) {
    return ui.resourceUrl();
  },

  render() {
    return <Section>
      <Field
        label="Deploy access"
        description="This binding lets the gadget deploy static-site demos as private Workers into the connected Cloudflare account and tear them down. Each deploy and teardown is queued for your approval.">
      </Field>
    </Section>;
  },
} satisfies ConfiguratorUISpec<CloudflareAccountConfiguratorRpc, CloudflareAccountConfiguratorValues>;

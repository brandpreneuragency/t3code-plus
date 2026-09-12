import { useNavigation } from "@react-navigation/native";
import {
  formatObservedAt,
  formatPlanType,
  formatResetsAt,
  formatUsedPercent,
} from "@t3tools/shared/usageLimitsFormat";
import type { MergedUsageLimitProvider } from "@t3tools/shared/usageLimitsMerge";
import { Platform, RefreshControl, ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AndroidScreenHeader } from "../../components/AndroidScreenHeader";
import { AppText as Text } from "../../components/AppText";
import { NativeStackScreenOptions } from "../../native/StackHeader";
import { useUsageLimits, type EnvironmentUsageLimitsStatus } from "../../state/usageLimits";
import { PROVIDER_LABEL, PROVIDER_ORDER } from "./usageProviders";

export function UsageLimitsRouteScreen() {
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const { merged, environments, isPending, refresh } = useUsageLimits();
  const refreshing = environments.some((entry) => entry.isPending && entry.summary !== null);
  const showEnvironmentLabels = merged.contributingEnvironments.length > 1;
  const groups = groupByEnvironment(merged.providers);

  return (
    <View collapsable={false} className="flex-1 bg-sheet">
      {Platform.OS === "android" ? (
        <>
          <NativeStackScreenOptions options={{ headerShown: false }} />
          <AndroidScreenHeader title="Limits" onBack={() => navigation.goBack()} />
        </>
      ) : null}
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        showsVerticalScrollIndicator={false}
        className="flex-1"
        contentContainerClassName="gap-6 px-5 pt-4"
        contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 18) + 18 }}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={refresh} />}
      >
        <LimitsCoverageNotice environments={environments} merged={merged} />
        <Text className="text-base text-foreground-muted">
          Last-seen plan windows from local session files. They update after a provider turn writes
          a snapshot.
        </Text>
        {isPending ? (
          <Text className="py-16 text-center text-base text-foreground-muted">
            Reading provider session files…
          </Text>
        ) : environments.length === 0 ? (
          <Text className="py-16 text-center text-base text-foreground-muted">
            Connect an environment to see remaining limits.
          </Text>
        ) : (
          groups.map((group) => (
            <View key={group.environmentId} className="gap-3">
              {showEnvironmentLabels ? (
                <Text className="text-sm font-t3-medium text-foreground">
                  {group.environmentLabel}
                </Text>
              ) : null}
              {PROVIDER_ORDER.map((provider) => {
                const snapshot = group.providers.find((entry) => entry.provider === provider);
                if (snapshot === undefined) return null;
                return <ProviderLimitCard key={provider} snapshot={snapshot} />;
              })}
            </View>
          ))
        )}
      </ScrollView>
    </View>
  );
}

function groupByEnvironment(providers: readonly MergedUsageLimitProvider[]) {
  const groups: {
    environmentId: string;
    environmentLabel: string;
    providers: MergedUsageLimitProvider[];
  }[] = [];
  for (const snapshot of providers) {
    const existing = groups.find((group) => group.environmentId === snapshot.environmentId);
    if (existing === undefined) {
      groups.push({
        environmentId: snapshot.environmentId,
        environmentLabel: snapshot.environmentLabel,
        providers: [snapshot],
      });
      continue;
    }
    existing.providers.push(snapshot);
  }
  return groups;
}

function ProviderLimitCard({ snapshot }: { readonly snapshot: MergedUsageLimitProvider }) {
  const plan = formatPlanType(snapshot.planType);
  const observed = formatObservedAt(snapshot.observedAt);
  return (
    <View className="gap-3 rounded-[24px] border-continuous bg-card p-4">
      <View className="flex-row items-baseline gap-2">
        <Text className="text-lg text-foreground">{PROVIDER_LABEL[snapshot.provider]}</Text>
        {plan !== null ? <Text className="text-sm text-foreground-muted">{plan}</Text> : null}
        {observed !== null ? (
          <Text className="ml-auto text-sm text-foreground-muted">{observed}</Text>
        ) : null}
      </View>
      {snapshot.status === "ok" && snapshot.windows.length > 0 ? (
        snapshot.windows.map((window) => {
          const width =
            window.usedPercent === null ? 0 : Math.min(100, Math.max(0, window.usedPercent));
          const reset = formatResetsAt(window.resetsAt);
          return (
            <View key={window.id} className="gap-1">
              <View className="flex-row items-baseline justify-between gap-3">
                <Text className="text-base text-foreground">{window.label}</Text>
                <Text className="text-sm text-foreground-muted">
                  {window.reached ? "Limit reached" : formatUsedPercent(window.usedPercent)}
                  {reset !== null ? ` · ${reset}` : ""}
                </Text>
              </View>
              <View className="h-1.5 overflow-hidden rounded-full bg-border">
                <View
                  className={
                    window.reached ? "h-full bg-danger-foreground" : "h-full bg-foreground"
                  }
                  style={{ width: `${width}%` }}
                />
              </View>
            </View>
          );
        })
      ) : (
        <Text className="text-base text-foreground-muted">
          {snapshot.message ?? "No recent limit snapshot."}
        </Text>
      )}
    </View>
  );
}

function LimitsCoverageNotice({
  environments,
  merged,
}: {
  readonly environments: readonly EnvironmentUsageLimitsStatus[];
  readonly merged: ReturnType<typeof useUsageLimits>["merged"];
}) {
  const failed = environments.filter((environment) => environment.error !== null);
  if (
    failed.length === 0 &&
    merged.staleEnvironments.length === 0 &&
    merged.duplicateSources.length === 0
  ) {
    return null;
  }
  return (
    <View className="gap-1">
      {failed.map((environment) => (
        <Text key={environment.label} className="text-sm text-foreground-muted">
          {environment.label} could not report limits.
        </Text>
      ))}
    </View>
  );
}

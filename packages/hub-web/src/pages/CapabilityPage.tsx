import type { LucideIcon } from "lucide-react";
import {
  ArrowLeft,
  GitPullRequestArrow,
  History,
  ListChecks,
} from "lucide-react";
import { Link, useLocation } from "react-router-dom";
import { PageHeader } from "../components/ui";
import { Badge } from "../components/primitives/badge";
import { buttonVariants } from "../components/primitives/button";
import { Card, CardContent } from "../components/primitives/card";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "../components/primitives/empty";
import { cn } from "../lib/utils";
import capabilityStyles from "../styles/capability.module.css";
import notFoundStyles from "../styles/not-found.module.css";

interface RoadmapPageDefinition {
  title: string;
  icon: LucideIcon;
  description: string;
}

export const roadmapPages = {
  playbooks: {
    title: "Playbooks",
    icon: ListChecks,
    description: "Reusable team workflows are planned but are not available in this release.",
  },
  "catch-up": {
    title: "Catch Up",
    icon: History,
    description: "A personalized summary of project changes and team activity is planned but is not available in this release.",
  },
} satisfies Record<string, RoadmapPageDefinition>;

export function RoadmapPage({ page }: { page: keyof typeof roadmapPages }) {
  const definition = roadmapPages[page];
  const Icon = definition.icon;

  return (
    <div className={capabilityStyles.page}>
      <PageHeader
        title={definition.title}
        actions={(
          <Badge className={capabilityStyles.headerStatus} role="status" variant="secondary">Soon</Badge>
        )}
      />

      <Card className={capabilityStyles.boundaryCard} size="sm" aria-labelledby="roadmap-boundary-title">
        <CardContent className={capabilityStyles.boundaryContent}>
          <Empty className={capabilityStyles.boundaryEmpty}>
            <EmptyMedia className={capabilityStyles.capabilityIcon} variant="icon">
              <Icon aria-hidden="true" />
            </EmptyMedia>
            <EmptyHeader className={capabilityStyles.boundaryHeader}>
              <EmptyTitle id="roadmap-boundary-title" role="heading" aria-level={2}>
                {definition.title} is coming soon
              </EmptyTitle>
              <EmptyDescription>{definition.description}</EmptyDescription>
            </EmptyHeader>
          </Empty>
        </CardContent>
      </Card>
    </div>
  );
}

export const CapabilityPage = RoadmapPage;

export function NotFoundPage() {
  const location = useLocation();
  const requestedPath = location.pathname || "/";

  return (
    <div className={notFoundStyles.page}>
      <Card className={notFoundStyles.resolutionCard} size="sm">
        <CardContent className={notFoundStyles.resolutionContent}>
          <Empty className={notFoundStyles.resolution}>
            <EmptyMedia className={notFoundStyles.routeIcon} variant="icon">
              <GitPullRequestArrow aria-hidden="true" />
            </EmptyMedia>
            <Badge className={notFoundStyles.code} variant="outline">404</Badge>
            <EmptyHeader className={notFoundStyles.resolutionHeader}>
              <EmptyTitle id="route-resolution-title" role="heading" aria-level={1}>Page not found</EmptyTitle>
              <EmptyDescription>No route matches this address.</EmptyDescription>
            </EmptyHeader>
            <code className={notFoundStyles.requestPath}>{requestedPath}</code>
            <EmptyContent>
              <Link className={cn(buttonVariants({ size: "sm" }), notFoundStyles.returnLink)} to="/">
                <ArrowLeft aria-hidden="true" data-icon="inline-start" />
                Return home
              </Link>
            </EmptyContent>
          </Empty>
        </CardContent>
      </Card>
    </div>
  );
}

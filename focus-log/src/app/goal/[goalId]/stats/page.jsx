"use client";

import React from "react";
import { useParams } from "next/navigation";
import ContributionGrid from "../../../../../components/ContributionGrid";

export default function VisualizationPage() {
  // Use the useParams hook to get the goalId
  const { goalId } = useParams();

  return (
    <div className="goal-page-container">
      <header>
        <h1 className="goal-title">Your Focus</h1>
      </header>
      <ContributionGrid goalId={goalId} />
    </div>
  );
}

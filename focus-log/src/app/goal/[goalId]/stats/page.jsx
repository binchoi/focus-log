"use client";

import React from "react";
import { useParams } from "next/navigation";
import ContributionGrid from "../../../../../components/ContributionGrid";
import Last10DaysChart from "../../../../../components/Last10DaysChart";
import Navbar from "../../../../../components/Navbar";

export default function VisualizationPage() {
  const { goalId } = useParams();

  return (
    <div className="goal-page-container">
      <Navbar />
      <header style={{ marginTop: "80px" }}>
        <h1 className="goal-title">Your Focus</h1>
      </header>
      <ContributionGrid goalId={goalId} />
      <div className="chart-wrapper">
        <h2 className="chart-title">Last 10 Days Focus Minutes</h2>
        <Last10DaysChart goalId={goalId} />
      </div>
    </div>
  );
}

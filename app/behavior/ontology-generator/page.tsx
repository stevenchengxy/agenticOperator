"use client";
import { Shell } from "@/components/shared/Shell";
import { OntologyGeneratorContent } from "@/components/behavior/ontology-generator/OntologyGeneratorContent";

export default function OntologyGeneratorPage() {
  return (
    <Shell crumbs={["Ontology Generator"]} directionTag="Behavior · Ontology Generator">
      <OntologyGeneratorContent />
    </Shell>
  );
}

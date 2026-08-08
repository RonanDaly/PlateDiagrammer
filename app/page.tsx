import type { Metadata } from "next";
import PlateEditor from "./PlateEditor";

export const metadata: Metadata = {
  title: "Plate Studio — Statistical diagram editor",
  description: "Create, edit, and export publication-ready statistical plate diagrams.",
};

export default function Home() {
  return <PlateEditor />;
}


export interface ExampleGroup {
  label: string;
  examples: { name: string; url: string }[];
}

export const exampleGroups: ExampleGroup[] = [
  {
    label: "Boutiques",
    examples: [
      {
        name: "FSL bet",
        url: "https://raw.githubusercontent.com/styx-api/niwrap/main/src/niwrap/fsl/6.0.4/bet/boutiques.json",
      },
      {
        name: "FSL flirt",
        url: "https://raw.githubusercontent.com/styx-api/niwrap/main/src/niwrap/fsl/6.0.4/flirt/boutiques.json",
      },
      {
        name: "FSL fast",
        url: "https://raw.githubusercontent.com/styx-api/niwrap/main/src/niwrap/fsl/6.0.4/fast/boutiques.json",
      },
      {
        name: "FreeSurfer recon-all",
        url: "https://raw.githubusercontent.com/styx-api/niwrap/main/src/niwrap/freesurfer/7.4.1/recon-all/boutiques.json",
      },
      {
        name: "ANTs antsRegistration",
        url: "https://raw.githubusercontent.com/styx-api/niwrap/main/src/niwrap/ants/2.5.3/antsRegistration/boutiques.json",
      },
    ],
  },
  {
    label: "Argdump",
    examples: [
      {
        name: "fmriprep",
        url: "https://raw.githubusercontent.com/styx-api/argdump/main/examples/fmriprep.json",
      },
      {
        name: "mriqc",
        url: "https://raw.githubusercontent.com/styx-api/argdump/main/examples/mriqc.json",
      },
    ],
  },
];

export const defaultExample = exampleGroups[0].examples[0];

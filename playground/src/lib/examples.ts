export interface Example {
  name: string;
  url: string;
}

export interface ExampleGroup {
  label: string;
  examples: [Example, ...Example[]];
}

export const exampleGroups: [ExampleGroup, ...ExampleGroup[]] = [
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
        name: "fMRIPrep",
        url: import.meta.env.BASE_URL + "examples/fmriprep_25.2.3_dump.json",
      },
    ],
  },
];

export const defaultExample = exampleGroups[0].examples[0];

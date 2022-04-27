import gplay from "google-play-scraper";
import adbkit from "@devicefarmer/adbkit";
import inquirer from "inquirer";
import checkboxPlus from "inquirer-checkbox-plus-prompt";
import Fuse from "fuse.js";

const BottomBar = inquirer.ui.BottomBar;
inquirer.registerPrompt("checkbox-plus", checkboxPlus);

const ipRegex = /^(?:(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.){3}(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)$/;

/** @returns {{ host?: string, port?: number }} */
const getAdbServer = () => {
  const socket = process.env["ADB_SERVER_SOCKET"];
  if (!socket.startsWith("tcp:")) return Object.create(null);
  const host = socket.substring(4, socket.indexOf(":", 4));
  if (!ipRegex.test(host)) return Object.create(null);
  const port = Number(socket.substring(socket.indexOf(":", 4) + 1));
  if (!(Number.isInteger(port) && port > 0 && port <= 65535)) return Object.create(null);
  return ({ host, port });
};

/** @type {import("@devicefarmer/adbkit").Client} */
const client = adbkit.default.createClient(getAdbServer());

/** @returns {string | { value: string, name: string }} */
const pkgToChoice = (item) => {
  if (item.title && item.developer) {
    return {
      name: item.label,
      value: item.appId,
    };
  }
  return item.appId;
};

const main = async () => {
  const devices = await client.listDevices();
  const deviceChoices = await Promise.all(devices.filter(meta => meta.type !== "offline").map(async meta => {
    const device = client.getDevice(meta.id);
    const props = await device.getProperties();
    const model = props["ro.product.model"].trim();
    const label = `${model.length > 0 ? model : meta.id} (${meta.type})`;
    return ({
      value: meta.id,
      name: label,
    });
  }));
  const { device: selectedDevice } = await inquirer.prompt({
    name: "device",
    type: "list",
    message: "Select device to use",
    choices: deviceChoices,
  });

  const device = client.getDevice(selectedDevice);
  const packages = await device.getPackages();

  const packagesBar = new BottomBar({ bottomBar: `0/${packages.length} packages fetched` });
  let counter = 0;

  const metadata = await Promise.all(packages.map(async id => {
    try {
      const app = await gplay.app({ appId: id });
      packagesBar.updateBottomBar(`${counter++}/${packages.length} packages fetched`);
      return ({
        appId: id,
        label: `${app.title} by ${app.developer} (${id})`,
        title: app.title,
        summary: app.summary,
        developer: app.developer,
      });
    } catch (err) {
      packagesBar.updateBottomBar(`${counter++}/${packages.length} packages fetched`);
      return ({
        appId: id,
      });
    }
  }));

  const searchable = new Fuse(metadata, {
    keys: ["appId", "title", "summary", "developer"]
  });

  const { packages: selectedPkgs } = await inquirer.prompt({
    name: "packages",
    type: "checkbox-plus",
    message: "Select packages to uninstall",
    pageSize: 10,
    highlight: true,
    searchable: true,
    source: async (answers, input) => {
      if (typeof input !== "string" || input.length === 0) return metadata.map(pkgToChoice);
      const matches = searchable.search(input);
      return matches.map(match => pkgToChoice(match.item));
    },
  });
  
  await inquirer.prompt({
    name: "confirmation",
    type: "input",
    message: "Are you sure you want to delete the selected packages? This action is destructive. Type \"I know what I'm doing\" to confirm.",
    validate: (input) => input === "I know what I'm doing",
  });

  if (!Array.isArray(selectedPkgs)) throw new Error(`Expected array, got ${typeof selectedPkgs}.`);

  const uninstallBar = new BottomBar({ bottomBar: `0/${selectedPkgs.length} packages uninstalled (0 errors)` });
  counter = 0;
  const unsuccessfull = [];

  for (const pkg of selectedPkgs) {
    const status = await device.uninstall(pkg);
    if (status) counter++;
    else unsuccessfull.push(pkg);
    uninstallBar.updateBottomBar(`${counter}/${selectedPkgs.length} packages uninstalled (${unsuccessfull.length} error${unsuccessfull.length === 1 ? '' : 's'})`);
  }

  if (unsuccessfull.length > 0) {
    console.error("\nUnable to uninstall:", unsuccessfull);
    process.exit(1);
  }

  console.log(`\n${counter} apps were uninstalled successfully!`);
  process.exit(0);
};

main();

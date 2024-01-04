/**
 * Store Cardano stake pool snapshot data from Koios into a local SQLite database.
 */
import sqlite3 from "sqlite3";
import axios from "axios";
import rateLimit from "axios-rate-limit";
import { program } from "commander";

sqlite3.verbose();

const koiosApiKey =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJhZGRyIjoic3Rha2UxdXhlZXFoZWFlZjY3Y2o3YWdxenNqbGphZTA2eWVsZjA4Zjg2dmU2cXBodTA1N2M0czB2MGciLCJleHAiOjE3MzM4NDIzMzEsInRpZXIiOjEsInByb2pJRCI6IklTUE8ifQ.ED1_1ktNZiceQDhDc0OAZ_-c_pSbk8I9zSHdkB3cxcw";
const koiosBaseUrl = "https://api.koios.rest/api/v1";
const axiosRL = rateLimit(axios.create(), { maxRPS: 8 });
let currentEpoch = null;
let koiosConfig = {
  method: "get",
  maxBodyLength: Infinity,
  keepAlive: true,
  headers: {
    accept: "application/json",
    authorization: "Bearer " + koiosApiKey,
  },
};

// Parse commandline arguments
program
  .name("snapshotter.js")
  .description(
    "Store Cardano stake pool snapshot data from Koios into a local SQLite database."
  )
  .usage("[OPTIONS]...")
  .option("-e, --epoch <number>", "the epoch number to save a snapshot of")
  .option("-f, --force", "disregard the constraint to run on last epoch day")
  .version("0.1.0", "-v, --version")
  .parse(process.argv);

const options = program.opts();

// Connect to the database
const db = new sqlite3.Database(
  "./snapshotter.sqlite",
  sqlite3.OPEN_READWRITE,
  (err) => {
    if (err) {
      console.error(
        `Database snapshotter.sqlite not found!\nRun the following command to create it:\n cat schema.sql | sqlite3 snapshotter.sqlite`
      );
      process.exit(1);
    }
  }
);

// Set the current epoch number
if (options.epoch) {
  currentEpoch = options.epoch;
} else {
  koiosConfig.url = koiosBaseUrl + "/tip";
  await axiosRL(koiosConfig)
    .then(function (response) {
      currentEpoch = response.data[0].epoch_no;
    })
    .catch(function (err) {
      console.error(err.message);
      process.exit(1);
    });
}

let poolFetchPromises = [];

db.all(`SELECT * FROM pool`, [], (err, rows) => {
  if (err) {
    throw err;
  }

  rows.forEach((row) => {
    koiosConfig.url =
      koiosBaseUrl +
      "/pool_delegators_history?_pool_bech32=" +
      row.bech32 +
      "&_epoch_no=" +
      currentEpoch;
    poolFetchPromises.push(getPoolDelegations(row));
  });

  Promise.all(poolFetchPromises).then(() => {
    sumAmounts();
  });
});

const getPoolDelegations = (row) => {
  return new Promise((resolve, reject) => {
    axiosRL(koiosConfig)
      .then((response) => {
        let contentRange = response.headers["content-range"]
          .substring(0, response.headers["content-range"].indexOf("/"))
          .split("-");
        insertPoolDelegations(row.id, response.data);
        console.log(
          "Pool: " +
            row.ticker.toString().padEnd(5, " ") +
            "   Range: " +
            contentRange[0].padStart(5, " ") +
            " - " +
            contentRange[1].padStart(5, " ")
        );

        if (contentRange[1].slice(-3) == "999") {
          koiosConfig.url =
            koiosBaseUrl +
            "/pool_delegators_history?_pool_bech32=" +
            row.bech32 +
            "&_epoch_no=" +
            currentEpoch +
            "&offset=" +
            (parseInt(contentRange[1], 10) + 1);
          getPoolDelegations(row).then(resolve).catch(reject);
        } else {
          resolve();
        }
      })
      .catch((err) => {
        console.error(err.message);
        reject();
      });
  });
};

const insertPoolDelegations = (id, delegations) => {
  delegations.forEach((delegation) => {
    db.run(
      `
            INSERT INTO snapshot (
                stake_address,
                epoch_no,
                amount,
                delegated_to,
                created_at)
            VALUES (?, ?, ?, ?, ?)`,
      [
        delegation.stake_address,
        delegation.epoch_no,
        delegation.amount,
        id,
        Date.now(),
      ],
      function (err) {
        if (err) {
          console.error(err.message);
        }
      }
    );
  });
};

const sumAmounts = () => {
  db.get(
    `SELECT SUM(amount) AS total_amount FROM snapshot WHERE epoch_no = ?`,
    [currentEpoch],
    (err, row) => {
      if (err) {
        throw err;
      }
      console.log(
        "Total Amount Summed for Epoch",
        currentEpoch,
        ":",
        row.total_amount
      );
      insertEpochSummary(currentEpoch, row.total_amount);
    }
  );
};

const insertEpochSummary = (epoch, totalAmount) => {
  db.run(
    `
        INSERT INTO epoch_summary (epoch_no, total_amount) 
        VALUES (?, ?)
        ON CONFLICT(epoch_no) 
        DO UPDATE SET total_amount = excluded.total_amount`,
    [epoch, totalAmount],
    function (err) {
      if (err) {
        console.error(err.message);
      }
    }
  );
};

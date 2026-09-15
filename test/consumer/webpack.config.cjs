const path = require("node:path");

module.exports = {
  mode: "production",
  entry: "./src/consumer.ts",
  output: {
    path: path.resolve(__dirname, "dist"),
    filename: "consumer.js"
  },
  resolve: {
    extensions: [".ts", ".js"]
  },
  module: {
    rules: [
      {
        test: /\\.ts$/,
        use: "ts-loader",
        exclude: /node_modules/
      }
    ]
  }
};

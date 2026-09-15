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
        test: /\.ts$/,
        use: {
          loader: "ts-loader",
          options: { transpileOnly: true }
        },
        exclude: /node_modules/
      }
    ]
  }
};

require("dotenv").config();
var express = require("express");
var crypto = require("crypto");
var path = require("path");
var sqlite = require("node:sqlite");
var Database = sqlite.DatabaseSync || sqlite.Database;
var app = express();
app.use(
  express.json({
    verify: function (req, res, buf) {
      req.rawBody = buf;
    },
  }),
);
app.use(express.static(path.join(__dirname, "public")));
var db = new Database(path.join(__dirname, "rina.db"));
db.exec(
  "CREATE TABLE IF NOT EXISTS orders (id INTEGER PRIMARY KEY AUTOINCREMENT, reference TEXT UNIQUE NOT NULL, customer_name TEXT NOT NULL, customer_email TEXT NOT NULL, phone TEXT, address TEXT NOT NULL, items_json TEXT NOT NULL, subtotal INTEGER NOT NULL, delivery INTEGER NOT NULL, total INTEGER NOT NULL, payment_channel TEXT, status TEXT NOT NULL, checkout_request_id TEXT, created_at DATETIME DEFAULT CURRENT_TIMESTAMP)",
);
try {
  db.exec("ALTER TABLE orders ADD COLUMN checkout_request_id TEXT");
} catch (e) {}
var CATALOG_PRICES = {};
require(path.join(__dirname, "products.json")).forEach(function (p) {
  CATALOG_PRICES[p.id] = p.price;
});
function formatDarajaPhone(raw) {
  var p = String(raw || "").replace(/[^0-9]/g, "");
  if (p.indexOf("0") === 0) p = "254" + p.slice(1);
  if (p.indexOf("7") === 0 || p.indexOf("1") === 0) p = "254" + p;
  return p;
}
function darajaTimestamp() {
  var d = new Date(Date.now() + 10800000);
  function p(n) {
    return n < 10 ? "0" + n : "" + n;
  }
  return (
    "" +
    d.getUTCFullYear() +
    p(d.getUTCMonth() + 1) +
    p(d.getUTCDate()) +
    p(d.getUTCHours()) +
    p(d.getUTCMinutes()) +
    p(d.getUTCSeconds())
  );
}
function darajaBase() {
  return process.env.DARAJA_ENV === "production"
    ? "https://api.safaricom.co.ke"
    : "https://sandbox.safaricom.co.ke";
}
async function getDarajaToken() {
  var auth = Buffer.from(
    process.env.DARAJA_CONSUMER_KEY + ":" + process.env.DARAJA_CONSUMER_SECRET,
  ).toString("base64");
  var r = await fetch(
    darajaBase() + "/oauth/v1/generate?grant_type=client_credentials",
    { headers: { Authorization: "Basic " + auth } },
  );
  var d = await r.json();
  if (!d.access_token) throw new Error(d.errorMessage || "Daraja auth failed");
  return d.access_token;
}
app.post("/api/checkout", async function (req, res) {
  try {
    var b = req.body;
    if (
      !b.cart ||
      !b.cart.length ||
      !b.email ||
      !b.customerName ||
      !b.address
    ) {
      return res.status(400).json({ error: "Missing required order details." });
    }
    var subtotal = 0;
    for (var i = 0; i < b.cart.length; i++) {
      var item = b.cart[i];
      var unit = CATALOG_PRICES[item.id];
      if (!unit || item.qty < 1)
        return res.status(400).json({ error: "Invalid cart item." });
      subtotal += unit * item.qty;
    }
    var shipping = Number(b.deliveryFee) || 0;
    if (shipping === 300 && subtotal >= 4000) shipping = 0;
    var total = subtotal + shipping;
    var reference =
      "RINA-" + Date.now() + "-" + Math.floor(1000 + Math.random() * 9000);
    db.prepare(
      "INSERT INTO orders (reference,customer_name,customer_email,phone,address,items_json,subtotal,delivery,total,payment_channel,status) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
    ).run(
      reference,
      b.customerName,
      b.email,
      b.phone || "",
      b.address,
      JSON.stringify(b.cart),
      subtotal,
      shipping,
      total,
      b.method,
      "PENDING",
    );
    if (b.method === "mpesa") {
      if (!b.phone)
        return res
          .status(400)
          .json({ error: "M-Pesa phone number is required." });
      var sc = process.env.DARAJA_SHORTCODE || "174379";
      var pk =
        process.env.DARAJA_PASSKEY ||
        "bfb279f9aa9bdbcf158e97dd71a467cd2e0c893059b10f78e6b72ada1ed2c919";
      var ts = darajaTimestamp();
      var pw = Buffer.from(sc + pk + ts).toString("base64");
      var phone254 = formatDarajaPhone(b.phone);
      var token = await getDarajaToken();
      var stkRes = await fetch(
        darajaBase() + "/mpesa/stkpush/v1/processrequest",
        {
          method: "POST",
          headers: {
            Authorization: "Bearer " + token,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            BusinessShortCode: sc,
            Password: pw,
            Timestamp: ts,
            TransactionType: "CustomerPayBillOnline",
            Amount: Math.round(total),
            PartyA: phone254,
            PartyB: sc,
            PhoneNumber: phone254,
            CallBackURL: process.env.BASE_URL + "/api/webhooks/daraja",
            AccountReference: reference.slice(0, 12),
            TransactionDesc: "RINA Order",
          }),
        },
      );
      var stkData = await stkRes.json();
      console.log("Daraja STK:", stkData);
      if (stkData.ResponseCode !== "0") {
        return res
          .status(400)
          .json({
            error:
              stkData.errorMessage ||
              stkData.ResponseDescription ||
              "Daraja STK Push failed.",
          });
      }
      db.prepare(
        "UPDATE orders SET checkout_request_id=? WHERE reference=?",
      ).run(stkData.CheckoutRequestID, reference);
      return res.json({
        success: true,
        mode: "stk_push",
        reference: reference,
        displayText:
          stkData.CustomerMessage ||
          "Enter your M-Pesa PIN on your phone to complete payment.",
      });
    } else {
      var cardRes = await fetch(
        "https://api.paystack.co/transaction/initialize",
        {
          method: "POST",
          headers: {
            Authorization: "Bearer " + process.env.PAYSTACK_SECRET_KEY,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            email: b.email,
            amount: String(total * 100),
            currency: "KES",
            reference: reference,
            channels: ["card"],
            callback_url:
              process.env.BASE_URL + "/checkout.html?verify=" + reference,
            metadata: { customerName: b.customerName, address: b.address },
          }),
        },
      );
      var cardData = await cardRes.json();
      if (!cardData.status) {
        return res
          .status(400)
          .json({ error: cardData.message || "Card checkout failed." });
      }
      return res.json({
        success: true,
        mode: "redirect",
        reference: reference,
        checkoutUrl: cardData.data.authorization_url,
      });
    }
  } catch (err) {
    console.error(err);
    res
      .status(500)
      .json({ error: err.message || "Server error processing payment." });
  }
});
app.post("/api/webhooks/daraja", function (req, res) {
  console.log("Daraja Callback:", JSON.stringify(req.body));
  var cb = req.body && req.body.Body && req.body.Body.stkCallback;
  if (cb && cb.CheckoutRequestID) {
    var newStatus = cb.ResultCode === 0 ? "PAID" : "FAILED";
    db.prepare("UPDATE orders SET status=? WHERE checkout_request_id=?").run(
      newStatus,
      cb.CheckoutRequestID,
    );
  }
  res.json({ ResultCode: 0, ResultDesc: "Accepted" });
});
app.get("/api/orders/verify/:reference", async function (req, res) {
  var reference = req.params.reference;
  var row = db
    .prepare(
      "SELECT status,total,payment_channel,checkout_request_id FROM orders WHERE reference=?",
    )
    .get(reference);
  if (!row) return res.json({ paid: false, status: "not_found" });
  if (row.status === "PAID")
    return res.json({ paid: true, reference: reference, amount: row.total });
  if (row.status === "FAILED")
    return res.json({ paid: false, status: "failed" });
  try {
    if (row.payment_channel === "mpesa" && row.checkout_request_id) {
      var sc = process.env.DARAJA_SHORTCODE || "174379";
      var pk =
        process.env.DARAJA_PASSKEY ||
        "bfb279f9aa9bdbcf158e97dd71a467cd2e0c893059b10f78e6b72ada1ed2c919";
      var ts = darajaTimestamp();
      var pw = Buffer.from(sc + pk + ts).toString("base64");
      var token = await getDarajaToken();
      var qRes = await fetch(darajaBase() + "/mpesa/stkpushquery/v1/query", {
        method: "POST",
        headers: {
          Authorization: "Bearer " + token,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          BusinessShortCode: sc,
          Password: pw,
          Timestamp: ts,
          CheckoutRequestID: row.checkout_request_id,
        }),
      });
      var qData = await qRes.json();
      if (String(qData.ResultCode) === "0") {
        db.prepare("UPDATE orders SET status=? WHERE reference=?").run(
          "PAID",
          reference,
        );
        return res.json({
          paid: true,
          reference: reference,
          amount: row.total,
        });
      }
      if (qData.ResultCode !== undefined && String(qData.ResultCode) !== "0") {
        db.prepare("UPDATE orders SET status=? WHERE reference=?").run(
          "FAILED",
          reference,
        );
        return res.json({ paid: false, status: "failed" });
      }
      return res.json({ paid: false, status: "pending" });
    }
    var psRes = await fetch(
      "https://api.paystack.co/transaction/verify/" +
        encodeURIComponent(reference),
      {
        headers: { Authorization: "Bearer " + process.env.PAYSTACK_SECRET_KEY },
      },
    );
    var psData = await psRes.json();
    if (psData.status && psData.data && psData.data.status === "success") {
      db.prepare("UPDATE orders SET status=? WHERE reference=?").run(
        "PAID",
        reference,
      );
      return res.json({
        paid: true,
        reference: reference,
        amount: psData.data.amount / 100,
      });
    }
    res.json({
      paid: false,
      status: psData.data ? psData.data.status : "pending",
    });
  } catch (e) {
    res.json({ paid: false, status: "pending" });
  }
});
app.post("/api/webhooks/paystack", function (req, res) {
  var hash = crypto
    .createHmac("sha512", process.env.PAYSTACK_SECRET_KEY)
    .update(req.rawBody)
    .digest("hex");
  if (hash !== req.headers["x-paystack-signature"]) return res.sendStatus(401);
  var event = req.body;
  if (event.event === "charge.success" && event.data && event.data.reference) {
    db.prepare("UPDATE orders SET status=? WHERE reference=?").run(
      "PAID",
      event.data.reference,
    );
  }
  res.sendStatus(200);
});
app.get("/api/admin/orders", function (req, res) {
  if (req.query.key !== process.env.ADMIN_KEY)
    return res.status(403).json({ error: "Unauthorized" });
  try {
    var rows = db
      .prepare("SELECT * FROM orders ORDER BY created_at DESC")
      .all();
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: "DB error" });
  }
});
app.listen(process.env.PORT || 3000, function () {
  console.log(
    "RINA PWA running at " + (process.env.BASE_URL || "http://localhost:3000"),
  );
});

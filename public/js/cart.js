function getCart() {
  return JSON.parse(localStorage.getItem("rina_cart") || "[]");
}
function saveCart(c) {
  localStorage.setItem("rina_cart", JSON.stringify(c));
  updateBagCount();
}
function getDeliveryFee() {
  return parseInt(localStorage.getItem("rina_delivery") || "300", 10);
}
function setDeliveryFee(fee) {
  localStorage.setItem("rina_delivery", String(fee));
}
function addToCart(productId, variantIdx) {
  if (!window.RINA_PRODUCTS) return;
  var p = window.RINA_PRODUCTS.find(function (x) {
    return x.id === productId;
  });
  if (!p) return;
  var v = p.variants[variantIdx || 0];
  var cart = getCart();
  var existing = cart.find(function (item) {
    return item.id === productId && item.variant === v.label;
  });
  if (existing) {
    existing.qty += 1;
  } else {
    cart.push({
      id: p.id,
      name: p.name,
      variant: v.label,
      price: p.price,
      img: v.img,
      qty: 1,
    });
  }
  saveCart(cart);
}
function calculateTotals() {
  var cart = getCart();
  var subtotal = cart.reduce(function (sum, item) {
    return sum + item.price * item.qty;
  }, 0);
  var zoneFee = getDeliveryFee();
  var delivery = cart.length === 0 ? 0 : zoneFee;
  if (zoneFee === 300 && subtotal >= 4000) delivery = 0;
  return { subtotal: subtotal, delivery: delivery, total: subtotal + delivery };
}
function updateBagCount() {
  var el = document.getElementById("cart-count");
  if (!el) return;
  el.textContent = getCart().reduce(function (s, i) {
    return s + i.qty;
  }, 0);
}
var deferredPrompt = null;
window.addEventListener("beforeinstallprompt", function (e) {
  e.preventDefault();
  deferredPrompt = e;
  var headerNav = document.querySelector(".nav-inner");
  if (headerNav && !document.getElementById("install-pwa-btn")) {
    var btn = document.createElement("button");
    btn.id = "install-pwa-btn";
    btn.className = "filter-btn";
    btn.textContent = "Install App";
    btn.onclick = function () {
      if (!deferredPrompt) return;
      deferredPrompt.prompt();
      deferredPrompt.userChoice.then(function () {
        deferredPrompt = null;
        btn.remove();
      });
    };
    headerNav.insertBefore(btn, headerNav.lastElementChild);
  }
});
document.addEventListener("DOMContentLoaded", function () {
  updateBagCount();
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("/sw.js").catch(function () {});
  }
  var params = new URLSearchParams(window.location.search);
  var verifyRef = params.get("verify");
  if (verifyRef) {
    fetch("/api/orders/verify/" + encodeURIComponent(verifyRef))
      .then(function (r) {
        return r.json();
      })
      .then(function (data) {
        if (data.paid) {
          localStorage.removeItem("rina_cart");
          updateBagCount();
          var box = document.getElementById("pay-status");
          if (box) {
            box.style.display = "block";
            box.innerHTML = `<strong>Payment Confirmed!</strong> Order ${data.reference} (KES ${data.amount.toLocaleString()}) has been received.`;
          } else {
            alert(`Payment confirmed for Order ${data.reference}!`);
          }
          window.history.replaceState(
            {},
            document.title,
            window.location.pathname,
          );
        }
      });
  }
});

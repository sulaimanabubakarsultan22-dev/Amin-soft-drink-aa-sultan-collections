# AMIN SOFT DRINK & A.A SULTAN COLLECTIONS — Admin Guide

## Add a new product
1. Open **Admin > Products > + Add product**.
2. Choose the **Product Type**: Drink, Clothing, or Goods; enter the product name, category, unit price and stock.
3. For drinks, optionally enter **carton price** and **carton quantity**. Customers can buy by unit or carton only when carton pricing is configured.
4. For clothing and goods, set the individual-item unit price. Carton pricing is unavailable for these product types.
5. Enter applicable **size**, **colors**, and **style** options so customers can select them before adding the product to their order.
6. Add the **front photo**, **back photo**, and optional **video URL** as needed.
7. Use **Featured**, **Best Seller**, **New Arrival**, and **Flash Deal** to control the marketplace merchandising sections. Tick **Low Stock** to flag an item manually; items with five or fewer in stock are also automatically shown as low stock.
8. Tick **Nuna a Talla / Featured** if you want the product to appear in the public Talla section.
9. Tick **Visible in store**, then Save.

## Change prices
- Use **Edit** for all product details.
- Use the quick **Farashi** button to change the unit price immediately.
- Use **Carton** to change or remove a drink's carton price; carton pricing does not apply to clothing or goods.

## Remove an item
- Use **Hide** when the item is temporarily unavailable. This keeps its order history safe.
- Use **Delete** when it has no past orders. If it has past orders, the system hides it instead of deleting the record.

## Customer contact
The store displays **Call** and **WhatsApp** using 08163827505. Add the real Facebook and Instagram URLs under **Admin > Settings**.

## Sabon tsarin Team
- Owner/Super Admin: cikakken iko.
- Admin: products, farashi, stock, orders, payments da settings.
- Staff: **Videos/Talla** kawai a dashboard; yana iya saka product videos har zuwa 10MB ko HTTPS URL.
- Customer Care: **Customer Care, Orders, Customers**; yana kula da Call/WhatsApp da taimakon customers.

## Videos
A public site akwai **🎥 Videos**. Staff ya shiga Admin → Videos, ya zaɓi product idan ya dace, ya upload MP4/WebM/OGG ko ya saka HTTPS URL. Customer zai iya kallon video ya danna Buy Now.

## Catalog
`npm start` yana gudanar da catalog seed kafin server. Seed ɗin ba ya sake rubuta farashi ko stock na products da suka riga sun kasance.

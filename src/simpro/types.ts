// Loose Simpro response shapes — fields are optional because Simpro responses
// vary by tenant configuration and endpoint version. We only type the fields
// our tools actually surface; everything else is preserved via `raw`.

export interface SimproRef {
  ID?: number;
  Name?: string;
}

export interface SimproAddress {
  Address?: string;
  City?: string;
  State?: string;
  PostalCode?: string;
  Country?: string;
}

export interface SimproCustomer {
  ID?: number;
  CompanyName?: string;
  GivenName?: string;
  FamilyName?: string;
  Email?: string;
  Phone?: string;
  CellPhone?: string;
  Type?: string;
  Archived?: boolean;
  [key: string]: unknown;
}

export interface SimproSite {
  ID?: number;
  Name?: string;
  Address?: SimproAddress;
  Customer?: SimproRef;
  PrimaryContact?: { GivenName?: string; FamilyName?: string; Email?: string; Phone?: string };
  [key: string]: unknown;
}

export interface SimproJob {
  ID?: number;
  JobNumber?: string;
  Customer?: SimproRef;
  Site?: SimproRef;
  Status?: SimproRef | string;
  Description?: string;
  DateIssued?: string;
  DueDate?: string;
  AssignedStaff?: SimproRef[];
  [key: string]: unknown;
}

export interface SimproQuote {
  ID?: number;
  Customer?: SimproRef;
  Site?: SimproRef;
  Status?: SimproRef | string;
  Description?: string;
  DateIssued?: string;
  DueDate?: string;
  [key: string]: unknown;
}

export interface SimproInvoice {
  ID?: number;
  Customer?: SimproRef;
  Status?: SimproRef | string;
  Total?: number | { ExTax?: number; IncTax?: number };
  DateIssued?: string;
  [key: string]: unknown;
}

export type Json = Record<string, unknown>;
